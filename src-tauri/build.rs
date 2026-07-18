fn main() {
    tauri_build::build();

    // tauri_build only emits rerun-if-changed for the individual resource
    // files it resolved via tauri.conf.json's glob at the time it last ran —
    // a brand-new file added to one of these directories isn't on that list,
    // so Cargo has nothing to compare its mtime against and never reruns the
    // build script (and therefore never recopies the stale resource bundle
    // into target/) just because a new widget/public file showed up. Watch
    // the directories themselves so additions/removals are caught too.
    println!("cargo:rerun-if-changed=../widgets");
    println!("cargo:rerun-if-changed=../public");

    // `tauri_build::build()` embeds the Common Controls v6 manifest into the
    // main app binary only (Cargo's build-script link args for bins don't
    // reach `cargo test` binaries). Some of our own code (native toast/dialog
    // paths pulled in by the hub's on-detect pipeline) statically imports
    // ComCtl32 v6-only exports (e.g. TaskDialogIndirect); without this same
    // manifest on test binaries, Windows loads the old v5 ComCtl32 and the
    // test exe fails to start with STATUS_ENTRYPOINT_NOT_FOUND.
    #[cfg(target_os = "windows")]
    {
        let manifest =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
