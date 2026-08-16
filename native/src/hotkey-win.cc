// Watching one key, everywhere, on Windows.
//
// WHY a native addon: push to talk needs both edges of a key press, and needs
// them while the app is in the background — that is the whole point of it, since
// the thing you are talking over is usually the thing you are looking at.
// Electron's globalShortcut gives neither. It is RegisterHotKey underneath,
// which reports a press and never a release, so the only release it could
// synthesise is a guess from the keyboard's auto-repeat — a guess that is
// wrong by the repeat delay on Windows and impossible on macOS, where the
// hotkey does not repeat at all. A microphone left open by a bad guess is the
// one failure this feature must not have.
//
// So: WH_KEYBOARD_LL, which reports every key down and up in the session, on a
// thread of its own with the message loop such a hook requires.
//
// WHAT LEAVES THIS FILE, because a low-level keyboard hook is shaped exactly
// like the thing nobody wants running on their machine: one boolean, when the
// configured key goes down or comes up. Not the key, not any other key, not a
// character, not a window. Every other keystroke is compared against the
// watched virtual-key code inside the hook and discarded there, and the hook
// installs nothing until push to talk is switched on and a key has been chosen.
//
// Nothing is ever swallowed. The hook always calls the next one and never
// reports a key as handled, so holding the push-to-talk key still types
// whatever that key types — which is why the settings page recommends one that
// types nothing. Eating keystrokes system-wide to spare somebody a stray letter
// would be a much larger thing to do to their machine than the letter is worth.
//
// WHAT IT CANNOT SEE: a window running elevated. Windows refuses keyboard hooks
// belonging to a lower integrity level any sight of input going to a higher
// one, so with an administrator window focused the key does nothing. There is
// no way around that short of the whole app running elevated, which is not a
// trade worth making for a microphone gate.

#include <napi.h>

#include <windows.h>

#include <atomic>
#include <memory>
#include <thread>

namespace {

// The modifier bits, as app/common/push-to-talk-key.ts counts them. Two files,
// one number: changing either alone is a hotkey that never matches.
constexpr int kCtrl = 1;
constexpr int kShift = 2;
constexpr int kAlt = 4;
constexpr int kMeta = 8;

// Zero means nothing is being watched, which is also what every path that
// cannot answer falls back to. No virtual-key code is zero.
std::atomic<DWORD> watchedKey{0};
std::atomic<int> watchedModifiers{0};

// Whether the watched key is down as far as this hook is concerned. It is the
// repeat filter as well as the state: Windows sends WM_KEYDOWN over and over
// while a key is held, and the far end wants the two transitions rather than a
// hundred of one of them.
std::atomic<bool> held{false};

std::atomic<DWORD> hookThreadId{0};
std::atomic<bool> hookInstalled{false};
Napi::ThreadSafeFunction emit;
std::thread hookThread;
HANDLE hookReady = nullptr;

// Whether there is a hook thread to stop. Touched only from the JavaScript
// thread, which is the only thread that starts or stops one.
bool running = false;

bool IsDown(int virtualKey) {
  return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
}

/** The modifier a key *is*, for keys that are one. Zero for everything else. */
int ModifierBit(DWORD virtualKey) {
  switch (virtualKey) {
    case VK_CONTROL:
    case VK_LCONTROL:
    case VK_RCONTROL:
      return kCtrl;
    case VK_SHIFT:
    case VK_LSHIFT:
    case VK_RSHIFT:
      return kShift;
    case VK_MENU:
    case VK_LMENU:
    case VK_RMENU:
      return kAlt;
    case VK_LWIN:
    case VK_RWIN:
      return kMeta;
    default:
      return 0;
  }
}

/**
 Which modifiers are held at this instant.

 Asked of the system rather than accumulated from the keys this hook has seen,
 which would drift: a modifier pressed before the hook was installed, or while
 an elevated window had focus, is one this hook never saw go down and would
 never see come up.
 */
int HeldModifiers() {
  int mask = 0;
  if (IsDown(VK_CONTROL)) {
    mask |= kCtrl;
  }
  if (IsDown(VK_SHIFT)) {
    mask |= kShift;
  }
  if (IsDown(VK_MENU)) {
    mask |= kAlt;
  }
  if (IsDown(VK_LWIN) || IsDown(VK_RWIN)) {
    mask |= kMeta;
  }
  return mask;
}

void Emit(bool down) {
  auto* state = new bool(down);
  const napi_status status = emit.NonBlockingCall(
      state, [](Napi::Env env, Napi::Function callback, bool* data) {
        std::unique_ptr<bool> owned(data);
        callback.Call({Napi::Boolean::New(env, *owned)});
      });

  // The queue is full or the function is closing. Dropping an edge would be
  // serious if it could happen in practice — a dropped release is an open
  // microphone — which is why the JavaScript side polls the key while the gate
  // is open rather than trusting these to be the only word on the subject.
  if (status != napi_ok) {
    delete state;
  }
}

/**
 The hook itself, called for every key in the session.

 It must be quick: Windows silently removes a low-level hook that takes longer
 than LowLevelHooksTimeout to answer, and a removed hook is a feature that stops
 working with no error anywhere. What is here is two atomic loads, four calls to
 GetAsyncKeyState, and — only for the one key being watched, only on its two
 transitions — a non-blocking queue push.
 */
LRESULT CALLBACK OnKey(int code, WPARAM message, LPARAM data) {
  if (code == HC_ACTION) {
    const auto* event = reinterpret_cast<const KBDLLHOOKSTRUCT*>(data);
    const DWORD key = watchedKey.load();

    if (key != 0 && event->vkCode == key) {
      const bool down =
          message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
      const bool up = message == WM_KEYUP || message == WM_SYSKEYUP;

      if (down && !held.load()) {
        // The watched key is discounted from the modifiers it is checked
        // against, so that binding a modifier on its own — left alt, right
        // control, the commonest push-to-talk keys there are — is a binding
        // that can match rather than one that requires itself.
        //
        // Exactly, not at least: with a bare key bound, holding control must
        // not open the microphone, or every Ctrl+V in the app would.
        if ((HeldModifiers() & ~ModifierBit(key)) == watchedModifiers.load()) {
          held.store(true);
          Emit(true);
        }
      } else if (up && held.load()) {
        // Unconditional, unlike the press. The modifiers are frequently let go
        // of first, and a release that waited for them to still be held is a
        // microphone that stays open.
        held.store(false);
        Emit(false);
      }
    }
  }

  return CallNextHookEx(nullptr, code, message, data);
}

void Run() {
  hookThreadId.store(GetCurrentThreadId());

  const HHOOK hook = SetWindowsHookExW(WH_KEYBOARD_LL, OnKey,
                                       GetModuleHandleW(nullptr), 0);
  hookInstalled.store(hook != nullptr);

  // Forcing the message queue into existence before anyone is told this thread
  // is ready. PostThreadMessage fails against a thread that has not got one
  // yet, and the failure would be a hook that cannot be stopped.
  MSG message;
  PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
  SetEvent(hookReady);

  if (hook != nullptr) {
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }

    UnhookWindowsHookEx(hook);
  }

  emit.Release();
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "start(onEdge: (down: boolean) => void)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (running) {
    return Napi::Boolean::New(env, true);
  }

  hookReady = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (hookReady == nullptr) {
    return Napi::Boolean::New(env, false);
  }

  emit = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                       "consort-push-to-talk", 0, 1);
  // Unreferenced so that a hook nobody has stopped cannot be the reason the
  // process will not exit. The app stops it on quit; this is the belt to that
  // pair of braces.
  emit.Unref(env);

  hookInstalled.store(false);
  hookThread = std::thread(Run);

  // Waited for rather than assumed, so that this can answer whether the hook is
  // actually installed. A refused hook is a setting that looks switched on and
  // does nothing, which is worth saying out loud in the one place that knows.
  WaitForSingleObject(hookReady, INFINITE);
  CloseHandle(hookReady);
  hookReady = nullptr;

  if (!hookInstalled.load()) {
    if (hookThread.joinable()) {
      hookThread.join();
    }
    return Napi::Boolean::New(env, false);
  }

  running = true;
  return Napi::Boolean::New(env, true);
}

Napi::Value SetKey(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "setKey(virtualKey: number, modifiers: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  watchedKey.store(info[0].As<Napi::Number>().Uint32Value());
  watchedModifiers.store(info[1].As<Napi::Number>().Int32Value());
  // A key changed under a finger that is still down would otherwise leave this
  // believing the new key is held. The caller closes its own gate to match.
  held.store(false);
  return env.Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  watchedKey.store(0);
  held.store(false);

  if (!running) {
    return env.Undefined();
  }

  running = false;
  const DWORD thread = hookThreadId.exchange(0);
  if (thread != 0) {
    PostThreadMessageW(thread, WM_QUIT, 0, 0);
  }

  if (hookThread.joinable()) {
    hookThread.join();
  }

  return env.Undefined();
}

/**
 Whether a key is physically down right now.

 The safety net under the hook. A release can be missed — the screen locks, a
 window running as administrator takes the key, a remote session changes hands —
 and a missed release is an open microphone that nobody knows about. So the
 caller asks this while its gate is open, and closes it the moment the answer is
 no.
 */
Napi::Value IsKeyDown(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "isKeyDown(virtualKey: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  return Napi::Boolean::New(
      env, IsDown(info[0].As<Napi::Number>().Int32Value()));
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("setKey", Napi::Function::New(env, SetKey));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isKeyDown", Napi::Function::New(env, IsKeyDown));
  return exports;
}

}  // namespace

NODE_API_MODULE(consort_hotkey, Init)
