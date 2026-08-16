// The hotkey addon on platforms with no system-wide key hook to offer.
//
// It exists so that building the app on Linux or macOS is not a failure over a
// Windows-only capability, and so that the main process can ask
// `isSupported()` rather than testing the platform in two places.
//
// Unlike the audio stub next door, nothing here throws. A key that cannot be
// watched is a setting the preferences window does not show, not a call
// somebody made by mistake — and the Linux answer to push to talk is a separate
// program that gates the microphone for every application at once, rather than
// anything this addon could grow into. See docs/push-to-talk.md.

#include <napi.h>

namespace {

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value IsKeyDown(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value Nothing(const Napi::CallbackInfo& info) {
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("setKey", Napi::Function::New(env, Nothing));
  exports.Set("stop", Napi::Function::New(env, Nothing));
  exports.Set("isKeyDown", Napi::Function::New(env, IsKeyDown));
  return exports;
}

}  // namespace

NODE_API_MODULE(consort_hotkey, Init)
