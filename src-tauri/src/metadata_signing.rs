//! Signature verification for the optional "official database" metadata
//! import path (Add Game > Import Game / Import Library).
//!
//! Anyone can still import a plain, unsigned `*_metadata.json` — that path
//! is untouched and stays safe on its own via `metadata::merge_entry`'s
//! "only fill empty fields" rule. This module adds a second, stronger tier:
//! a signed envelope that verifies against the public key below proves the
//! file came from BearddOddity's curated database (bearddoddity.github.io)
//! and hasn't been altered in transit, so the importer can show a genuine
//! "Verified" badge instead of just "someone's export."
//!
//! The matching private key lives only with BearddOddity (see
//! `tools/metadata-signer`) — it is never built into the app and never
//! committed to this repo. Losing it means rotating this constant and
//! re-signing the database; leaking it means anyone could forge a
//! "Verified" entry, so it's treated like any other release-signing key.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

/// Ed25519 public key (32 raw bytes, base64) for BearddOddity's official
/// game-metadata database. Safe to publish — it can only verify signatures,
/// never create them.
pub const OFFICIAL_PUBLIC_KEY_B64: &str = "ApISHpdtip3ezaOflMlN+f2b+asysAaCeyUW0WzK+Zs=";

/// Verifies `signature_b64` is a valid Ed25519 signature over the exact
/// bytes of `payload_json`, produced by the private key matching
/// `OFFICIAL_PUBLIC_KEY_B64`.
///
/// Returns `Ok(true)`/`Ok(false)` for a well-formed signature that does or
/// doesn't verify; `Err` only for input so malformed it can't even be
/// checked (bad base64, wrong key/signature length) — callers treat that
/// the same as a failed verification, this is just for a clearer error
/// message.
pub fn verify_official_signature(payload_json: &str, signature_b64: &str) -> Result<bool, String> {
    let key_bytes = STANDARD
        .decode(OFFICIAL_PUBLIC_KEY_B64)
        .map_err(|e| format!("embedded public key isn't valid base64: {}", e))?;
    let key_bytes: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| "embedded public key isn't 32 bytes".to_string())?;
    let verifying_key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|e| format!("embedded public key is invalid: {}", e))?;

    let sig_bytes = STANDARD
        .decode(signature_b64)
        .map_err(|e| format!("signature isn't valid base64: {}", e))?;
    let sig_bytes: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| "signature isn't 64 bytes".to_string())?;
    let signature = Signature::from_bytes(&sig_bytes);

    Ok(verifying_key
        .verify(payload_json.as_bytes(), &signature)
        .is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// Catches a typo/truncation in the embedded constant at test time
    /// instead of failing every real verification silently at runtime.
    #[test]
    fn embedded_public_key_decodes_to_32_bytes() {
        let bytes = STANDARD.decode(OFFICIAL_PUBLIC_KEY_B64).unwrap();
        assert_eq!(bytes.len(), 32);
        assert!(VerifyingKey::from_bytes(&bytes.try_into().unwrap()).is_ok());
    }

    // Self-contained: generates its own throwaway keypair rather than
    // depending on the real embedded constant, so this test doesn't need to
    // know the real private key (which doesn't exist in this repo at all).
    #[test]
    fn verifies_real_signature_and_rejects_tampered_payload() {
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let verifying_key = signing_key.verifying_key();
        let public_b64 = STANDARD.encode(verifying_key.to_bytes());

        let payload = r#"{"title":"Celeste","genre":"Platformer"}"#;
        let signature = signing_key.sign(payload.as_bytes());
        let signature_b64 = STANDARD.encode(signature.to_bytes());

        // Verify against a locally-known key (not OFFICIAL_PUBLIC_KEY_B64)
        // by decoding/checking manually — exercises the same primitives
        // verify_official_signature uses without needing to swap the
        // embedded constant out from under other tests.
        let key_bytes: [u8; 32] = STANDARD.decode(&public_b64).unwrap().try_into().unwrap();
        let vk = VerifyingKey::from_bytes(&key_bytes).unwrap();
        let sig_bytes: [u8; 64] = STANDARD.decode(&signature_b64).unwrap().try_into().unwrap();
        let sig = Signature::from_bytes(&sig_bytes);
        assert!(vk.verify(payload.as_bytes(), &sig).is_ok());

        let tampered = r#"{"title":"Celeste","genre":"RPG"}"#;
        assert!(vk.verify(tampered.as_bytes(), &sig).is_err());
    }

    #[test]
    fn rejects_malformed_signature_input() {
        assert!(verify_official_signature("{}", "not-base64!!!").is_err());
        assert!(verify_official_signature("{}", &STANDARD.encode("too short")).is_err());
    }
}
