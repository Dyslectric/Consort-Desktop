// The addon on platforms that have no process loopback to offer.
//
// It exists so that installing and building the app on Linux or macOS is not a
// failure over a Windows-only capability. `start` throws rather than returning
// silence: a caller that reaches it has asked for something this platform
// cannot do, and answering with an empty stream would look like an application
// that happens to be quiet.
//
// Nothing is lost on Linux, which sends an application's sound by rearranging
// the PulseAudio graph instead — see app/main/linux-audio-share.ts.

#include <napi.h>

namespace {

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Error::New(env,
                   "capturing one application's sound is only implemented on "
                   "Windows")
      .ThrowAsJavaScriptException();
  return env.Undefined();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  return info.Env().Undefined();
}

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  return exports;
}

}  // namespace

NODE_API_MODULE(consort_app_audio, Init)
