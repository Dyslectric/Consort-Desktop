// Capturing one application's sound, on Windows.
//
// WHY this exists: Electron's screen share reply takes `audio: "loopback"`,
// which means the default render device — everything the machine is playing.
// There is nothing per-window or per-application in that API, and the
// WebFrameMain form captures one of our own frames rather than somebody else's
// program. Windows can do it; Electron simply does not reach the call that
// does.
//
// That call is ActivateAudioInterfaceAsync against
// VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, which hands back an IAudioClient
// capturing only what one process — and, if asked, its children — renders.
// A window gives a PID through GetWindowThreadProcessId, and the picker already
// carries the window handle, so the whole chain from "that window" to "that
// window's sound" exists once this does.
//
// Written here rather than taken as a dependency. The approach is Microsoft's
// ApplicationLoopback sample and the MIT-licensed application-loopback addon;
// what is ours is the lifetime, which has to start and stop with a share rather
// than live as a process-wide singleton, and the delivery, which has to reach a
// ThreadSafeFunction without blocking the capture thread.
//
// WHAT IT CANNOT DO, so that nobody goes looking for the bug: a browser renders
// audio in a shared audio process, not in the process owning the window. Asking
// for a browser window's tree therefore captures every tab that browser is
// playing, not the one being shared. Per-application is the granularity on
// offer here; per-tab is not, and no arrangement of these flags produces it.

#include <napi.h>

#include <windows.h>

#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>

#include <atomic>
#include <memory>
#include <thread>
#include <vector>

namespace {

// What the capture is initialised to ask for. Process loopback has no mix
// format to interrogate — there is no endpoint behind it — so a format is
// stated rather than discovered, and everything downstream can rely on it.
// 48 kHz stereo 16-bit matches what the bridge window plays and what the call
// ultimately sends, so nothing has to resample.
constexpr WORD kChannels = 2;
constexpr DWORD kSampleRate = 48000;
constexpr WORD kBitsPerSample = 16;

// 20 ms, in 100-nanosecond units. Small enough that the sound is not noticeably
// behind the picture, large enough that the callback is not woken constantly.
constexpr REFERENCE_TIME kBufferDuration = 200000;

/**
 The completion handler ActivateAudioInterfaceAsync insists on.

 The activation is asynchronous and answers on a system thread, so the capture
 thread starts it, waits on the event below, and collects the result. Reference
 counting is hand-rolled because pulling in WRL for one object is not worth the
 include.
 */
class ActivationHandler : public IActivateAudioInterfaceCompletionHandler {
 public:
  ActivationHandler() : done_(CreateEvent(nullptr, TRUE, FALSE, nullptr)) {}

  ~ActivationHandler() {
    if (done_ != nullptr) {
      CloseHandle(done_);
    }
    if (client_ != nullptr) {
      client_->Release();
    }
  }

  /** Blocks until the activation answers, then yields the client it made. */
  HRESULT Wait(IAudioClient** client) {
    if (done_ == nullptr) {
      return E_FAIL;
    }
    WaitForSingleObject(done_, INFINITE);
    *client = client_;
    client_ = nullptr;  // Ownership moves to the caller.
    return result_;
  }

  STDMETHODIMP ActivateCompleted(
      IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activated = E_FAIL;
    IUnknown* unknown = nullptr;
    HRESULT hr = operation->GetActivateResult(&activated, &unknown);

    if (SUCCEEDED(hr)) {
      hr = activated;
    }
    if (SUCCEEDED(hr) && unknown != nullptr) {
      hr = unknown->QueryInterface(__uuidof(IAudioClient),
                                   reinterpret_cast<void**>(&client_));
    }
    if (unknown != nullptr) {
      unknown->Release();
    }

    result_ = hr;
    SetEvent(done_);
    return S_OK;
  }

  STDMETHODIMP QueryInterface(REFIID riid, void** object) override {
    if (object == nullptr) {
      return E_POINTER;
    }
    if (riid == __uuidof(IUnknown) ||
        riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
  }

  STDMETHODIMP_(ULONG) AddRef() override {
    return InterlockedIncrement(&references_);
  }

  STDMETHODIMP_(ULONG) Release() override {
    const LONG remaining = InterlockedDecrement(&references_);
    if (remaining == 0) {
      delete this;
    }
    return static_cast<ULONG>(remaining);
  }

 private:
  LONG references_ = 1;
  HANDLE done_ = nullptr;
  HRESULT result_ = E_FAIL;
  IAudioClient* client_ = nullptr;
};

/**
 One capture, running on a thread of its own until it is stopped.

 The thread owns every COM object it makes, which is the simplest way to be sure
 they are released on the apartment that created them. Stopping sets a flag and
 signals the same event the capture waits on, so a stop is noticed immediately
 rather than after one more buffer's worth of silence.
 */
class Capture {
 public:
  ~Capture() { Stop(); }

  /** Errors are reported by throwing in the caller's environment. */
  void Start(Napi::Env env, DWORD pid, bool includeProcessTree,
             Napi::Function callback) {
    if (running_.load()) {
      Napi::Error::New(env, "capture already running").ThrowAsJavaScriptException();
      return;
    }

    wake_ = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (wake_ == nullptr) {
      Napi::Error::New(env, "could not create the capture event")
          .ThrowAsJavaScriptException();
      return;
    }

    // Non-blocking: the audio thread must never wait on JavaScript. A queue
    // that fills is a sign the main process is wedged, and dropping a buffer is
    // the right answer there — the alternative stalls the capture as well.
    tsfn_ = Napi::ThreadSafeFunction::New(env, callback, "consort-app-audio", 0,
                                          1);
    running_.store(true);
    thread_ = std::thread(&Capture::Run, this, pid, includeProcessTree);
  }

  void Stop() {
    if (!running_.exchange(false)) {
      return;
    }
    if (wake_ != nullptr) {
      SetEvent(wake_);
    }
    if (thread_.joinable()) {
      thread_.join();
    }
    if (wake_ != nullptr) {
      CloseHandle(wake_);
      wake_ = nullptr;
    }
    tsfn_.Release();
  }

 private:
  void Run(DWORD pid, bool includeProcessTree) {
    // The capture lives entirely on this thread, so the apartment does too.
    const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool uninitialise = SUCCEEDED(com);

    IAudioClient* client = nullptr;
    IAudioCaptureClient* capture = nullptr;

    if (SUCCEEDED(Activate(pid, includeProcessTree, &client)) &&
        SUCCEEDED(Configure(client, &capture))) {
      Pump(client, capture);
    }

    if (capture != nullptr) {
      capture->Release();
    }
    if (client != nullptr) {
      client->Stop();
      client->Release();
    }
    if (uninitialise) {
      CoUninitialize();
    }
  }

  HRESULT Activate(DWORD pid, bool includeProcessTree, IAudioClient** client) {
    AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
    parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    parameters.ProcessLoopbackParams.TargetProcessId = pid;
    parameters.ProcessLoopbackParams.ProcessLoopbackMode =
        includeProcessTree ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                           : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

    PROPVARIANT activation{};
    activation.vt = VT_BLOB;
    activation.blob.cbSize = sizeof(parameters);
    activation.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);

    // Released by the handler's own reference counting, not here.
    ActivationHandler* handler = new ActivationHandler();
    IActivateAudioInterfaceAsyncOperation* operation = nullptr;

    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient),
        &activation, handler, &operation);

    if (SUCCEEDED(hr)) {
      hr = handler->Wait(client);
    }

    if (operation != nullptr) {
      operation->Release();
    }
    handler->Release();
    return hr;
  }

  HRESULT Configure(IAudioClient* client, IAudioCaptureClient** capture) {
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = kChannels;
    format.nSamplesPerSec = kSampleRate;
    format.wBitsPerSample = kBitsPerSample;
    format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

    // LOOPBACK because this is a render stream being captured, EVENTCALLBACK so
    // the pump below waits rather than polls. Periodicity must be zero in
    // shared mode, whatever the buffer duration.
    HRESULT hr = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        kBufferDuration, 0, &format, nullptr);

    if (SUCCEEDED(hr)) {
      hr = client->SetEventHandle(wake_);
    }
    if (SUCCEEDED(hr)) {
      hr = client->GetService(__uuidof(IAudioCaptureClient),
                              reinterpret_cast<void**>(capture));
    }
    if (SUCCEEDED(hr)) {
      hr = client->Start();
    }
    return hr;
  }

  void Pump(IAudioClient* client, IAudioCaptureClient* capture) {
    const WORD frameSize = kChannels * kBitsPerSample / 8;

    while (running_.load()) {
      WaitForSingleObject(wake_, 1000);

      UINT32 packet = 0;
      while (running_.load() && SUCCEEDED(capture->GetNextPacketSize(&packet)) &&
             packet > 0) {
        BYTE* data = nullptr;
        UINT32 frames = 0;
        DWORD flags = 0;

        if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr,
                                      nullptr))) {
          break;
        }

        if (frames > 0) {
          // A silent packet's memory is undefined rather than zeroed, so it is
          // sent as real silence. Sending nothing at all would be wrong: the
          // gap is part of what was played, and the bridge plays what it is
          // given in the order it arrives.
          auto chunk = std::make_unique<std::vector<uint8_t>>(
              static_cast<size_t>(frames) * frameSize, 0);
          if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && data != nullptr) {
            memcpy(chunk->data(), data, chunk->size());
          }
          Deliver(std::move(chunk));
        }

        capture->ReleaseBuffer(frames);
      }
    }
  }

  void Deliver(std::unique_ptr<std::vector<uint8_t>> chunk) {
    auto* raw = chunk.release();
    const napi_status status = tsfn_.NonBlockingCall(
        raw, [](Napi::Env env, Napi::Function callback,
                std::vector<uint8_t>* data) {
          std::unique_ptr<std::vector<uint8_t>> owned(data);
          callback.Call({Napi::Buffer<uint8_t>::Copy(env, owned->data(),
                                                     owned->size())});
        });

    // Queue full, or the function is closing: the buffer is ours to drop.
    if (status != napi_ok) {
      delete raw;
    }
  }

  std::atomic<bool> running_{false};
  std::thread thread_;
  HANDLE wake_ = nullptr;
  Napi::ThreadSafeFunction tsfn_;
};

/**
 The capture as JavaScript holds it.

 One object per share rather than a module-level singleton, so that a share
 ending releases everything it took and a stray stop cannot silence a capture it
 does not own.
 */
class AppAudioCapture : public Napi::ObjectWrap<AppAudioCapture> {
 public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function constructor =
        DefineClass(env, "AppAudioCapture",
                    {InstanceMethod("start", &AppAudioCapture::Start),
                     InstanceMethod("stop", &AppAudioCapture::Stop)});
    exports.Set("AppAudioCapture", constructor);
    return exports;
  }

  explicit AppAudioCapture(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<AppAudioCapture>(info),
        capture_(std::make_unique<Capture>()) {}

 private:
  Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsBoolean() ||
        !info[2].IsFunction()) {
      Napi::TypeError::New(
          env, "start(processId: number, includeProcessTree: boolean, "
               "onData: (chunk: Buffer) => void)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    capture_->Start(env, info[0].As<Napi::Number>().Uint32Value(),
                    info[1].As<Napi::Boolean>().Value(),
                    info[2].As<Napi::Function>());
    return env.Undefined();
  }

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    capture_->Stop();
    return info.Env().Undefined();
  }

  std::unique_ptr<Capture> capture_;
};

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  // Asked of the system rather than assumed from a build number: the
  // documentation and the samples disagree about which Windows 10 release first
  // carried process loopback, and a wrong constant here is a feature that is
  // either missing on machines that have it or broken on machines that do not.
  // Activation is the only authority, so availability is whether the symbol is
  // there to call at all; whether a capture starts is answered by starting one.
  const HMODULE mmdevapi = GetModuleHandleW(L"mmdevapi.dll");
  return Napi::Boolean::New(
      info.Env(),
      mmdevapi != nullptr &&
          GetProcAddress(mmdevapi, "ActivateAudioInterfaceAsync") != nullptr);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  return AppAudioCapture::Init(env, exports);
}

}  // namespace

NODE_API_MODULE(consort_app_audio, Init)
