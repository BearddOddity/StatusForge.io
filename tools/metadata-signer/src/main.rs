//! Standalone signing tool for BearddOddity's official game-metadata
//! database (bearddoddity.github.io) — NOT part of the shipped app. Not
//! built or bundled by release.yml, and never referenced by src-tauri.
//!
//! The private key this produces/uses must never be committed to this repo
//! or shipped in the app — only the matching public key (pasted into
//! `src-tauri/src/metadata_signing.rs::OFFICIAL_PUBLIC_KEY_B64`) goes out
//! to users. Anyone holding the private key can forge a "Verified official"
//! entry, so treat it like the Tauri updater signing key: password
//! manager or offline storage, never in git.
//!
//! Usage:
//!   metadata-signer keygen
//!       Generates a new keypair. Prints the public key to paste into
//!       metadata_signing.rs, and writes the private key to
//!       ./signing_key.b64 — move it somewhere secure and delete the
//!       local file once you have.
//!
//!   metadata-signer sign <entry.json> <out.json> [--key-file path]
//!       Signs entry.json's exact bytes (default key file:
//!       ./signing_key.b64) and writes the signed envelope to out.json.
//!       Works the same for a single game entry or a whole database dump
//!       — the app tells them apart by shape, this tool just signs bytes.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("keygen") => keygen(),
        Some("sign") => {
            let entry_path = args
                .get(2)
                .expect("usage: metadata-signer sign <entry.json> <out.json> [--key-file path]");
            let out_path = args
                .get(3)
                .expect("usage: metadata-signer sign <entry.json> <out.json> [--key-file path]");
            let key_file = args
                .iter()
                .position(|a| a == "--key-file")
                .and_then(|i| args.get(i + 1))
                .cloned()
                .unwrap_or_else(|| "signing_key.b64".to_string());
            sign(entry_path, out_path, &key_file);
        }
        _ => {
            eprintln!(
                "usage:\n  metadata-signer keygen\n  metadata-signer sign <entry.json> <out.json> [--key-file path]"
            );
            std::process::exit(1);
        }
    }
}

fn keygen() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let private_b64 = STANDARD.encode(signing_key.to_bytes());
    let public_b64 = STANDARD.encode(signing_key.verifying_key().to_bytes());

    std::fs::write("signing_key.b64", &private_b64).expect("failed to write signing_key.b64");

    println!("Public key (paste into src-tauri/src/metadata_signing.rs):");
    println!("{}", public_b64);
    println!();
    println!("Private key written to ./signing_key.b64 — move it somewhere secure");
    println!("(password manager, offline backup) and delete the local file.");
    println!("Anyone who gets this key can forge \"Verified official\" entries.");
}

fn sign(entry_path: &str, out_path: &str, key_file: &str) {
    let entry_json = std::fs::read_to_string(entry_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", entry_path, e));

    // Sanity check only — the exact bytes above get signed either way, so
    // pretty-printed vs. compact input both work identically.
    serde_json::from_str::<serde_json::Value>(&entry_json)
        .unwrap_or_else(|e| panic!("{} isn't valid JSON: {}", entry_path, e));

    let private_b64 = std::fs::read_to_string(key_file)
        .unwrap_or_else(|e| panic!("failed to read key file {}: {}", key_file, e));
    let key_bytes = STANDARD
        .decode(private_b64.trim())
        .expect("key file isn't valid base64");
    let key_bytes: [u8; 32] = key_bytes
        .try_into()
        .expect("private key must be 32 bytes");
    let signing_key = SigningKey::from_bytes(&key_bytes);

    let signature = signing_key.sign(entry_json.as_bytes());
    let signature_b64 = STANDARD.encode(signature.to_bytes());

    let envelope = serde_json::json!({
        "entry_json": entry_json,
        "signature": signature_b64,
        "signed_by": "BearddOddity",
    });
    std::fs::write(out_path, serde_json::to_string_pretty(&envelope).unwrap())
        .unwrap_or_else(|e| panic!("failed to write {}: {}", out_path, e));

    println!("Signed {} -> {}", entry_path, out_path);
}
