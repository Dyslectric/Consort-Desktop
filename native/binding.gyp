{
  # Capturing one application's sound on Windows.
  #
  # WHY a native addon at all: Electron's screen share reply takes
  # `audio: "loopback"`, which means the default render device — the whole
  # machine. There is nothing per-window or per-application in it, and the
  # WebFrameMain form captures one of our own frames rather than somebody
  # else's program. Windows itself can do this, through WASAPI process
  # loopback, and nothing in Electron reaches that API.
  #
  # It builds everywhere so that `npm install` on Linux and macOS is not a
  # failure. There is simply nothing to capture there: those platforms compile
  # a stub whose start() throws, and the Linux screen share has its own route
  # to the same end anyway — see app/main/linux-audio-share.ts.
  "targets": [
    {
      "target_name": "consort_app_audio",
      "include_dirs": ["<!(node -p \"require('node-addon-api').include_dir\")"],
      # Exceptions are used for the COM error handling below, and node-addon-api
      # needs to know which it was built against.
      "defines": ["NAPI_VERSION=8", "NOMINMAX", "UNICODE", "_UNICODE"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "conditions": [
        [
          "OS=='win'",
          {
            "sources": ["src/app-audio-win.cc"],
            # mmdevapi for ActivateAudioInterfaceAsync, ole32 for COM itself.
            "libraries": ["-lmmdevapi.lib", "-lole32.lib"],
            # No /std here on purpose: node-gyp's own toolchain already asks for
            # a newer standard than this needs, and stating one only overrides
            # it downwards with a warning to say so.
            #
            # No debug information either. A release build has no use for a
            # program database, and generating one makes every incremental build
            # after the first fail with LNK1103 "debugging information corrupt"
            # — which reads like a broken source file and is fixed by deleting
            # the build tree, so it costs a rebuild each time to learn nothing.
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "DebugInformationFormat": "0"
              },
              "VCLinkerTool": {"GenerateDebugInformation": "false"}
            }
          },
          {"sources": ["src/app-audio-unsupported.cc"]}
        ]
      ]
    }
  ]
}
