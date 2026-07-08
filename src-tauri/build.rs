fn main() {
    tauri_build::build();

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
