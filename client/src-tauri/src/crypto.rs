use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use aes_gcm::aead::Aead;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use rand::rngs::OsRng;
use rand::RngCore;
use x25519_dalek::{PublicKey, StaticSecret};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyPair {
    pub public_key_base64: String,
    pub private_key_base64: String,
}

/// Generate an ECDH key pair (Curve25519)
pub fn generate_keypair() -> KeyPair {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);

    KeyPair {
        public_key_base64: BASE64.encode(public.as_bytes()),
        private_key_base64: BASE64.encode(secret.to_bytes()),
    }
}

/// Restore a key pair from a stored private key (for restart persistence)
pub fn restore_keypair_from_private(private_key_b64: &str) -> Result<KeyPair, String> {
    let private_bytes = BASE64.decode(private_key_b64)
        .map_err(|e| format!("Failed to decode private key: {}", e))?;

    let secret_array = <[u8; 32]>::try_from(private_bytes)
        .map_err(|_| "Invalid private key length")?;
    let secret = StaticSecret::from(secret_array);
    let public = PublicKey::from(&secret);

    Ok(KeyPair {
        public_key_base64: BASE64.encode(public.as_bytes()),
        private_key_base64: BASE64.encode(secret.to_bytes()),
    })
}

/// Generate a persistent device UUID (v4-like)
pub fn generate_uuid() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    // Set version to 4 (random UUID)
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    // Set variant to RFC 4122
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    // Format as standard UUID string
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

/// Compute shared secret from our private key and partner's public key
pub fn compute_shared_secret(my_private_b64: &str, partner_public_b64: &str) -> Result<String, String> {
    let my_private_bytes = BASE64.decode(my_private_b64)
        .map_err(|e| format!("Failed to decode private key: {}", e))?;
    let partner_public_bytes = BASE64.decode(partner_public_b64)
        .map_err(|e| format!("Failed to decode partner public key: {}", e))?;

    let my_secret = StaticSecret::from(<[u8; 32]>::try_from(my_private_bytes)
        .map_err(|_| "Invalid private key length")?);
    let partner_public = PublicKey::from(<[u8; 32]>::try_from(partner_public_bytes)
        .map_err(|_| "Invalid public key length")?);

    let shared = my_secret.diffie_hellman(&partner_public);
    Ok(BASE64.encode(shared.as_bytes()))
}

/// Encrypt a message with AES-256-GCM using the shared secret
pub fn encrypt_message(shared_secret_b64: &str, plaintext: &str) -> Result<EncryptedPayload, String> {
    let secret_bytes = BASE64.decode(shared_secret_b64)
        .map_err(|e| format!("Failed to decode shared secret: {}", e))?;
    let key_bytes = <[u8; 32]>::try_from(secret_bytes)
        .map_err(|_| "Invalid shared secret length")?;

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;

    // Generate random 12-byte nonce
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher.encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption failed: {}", e))?;

    Ok(EncryptedPayload {
        nonce: BASE64.encode(&nonce_bytes),
        ciphertext: BASE64.encode(&ciphertext),
    })
}

/// Decrypt a message with AES-256-GCM using the shared secret
pub fn decrypt_message(shared_secret_b64: &str, payload: &EncryptedPayload) -> Result<String, String> {
    let secret_bytes = BASE64.decode(shared_secret_b64)
        .map_err(|e| format!("Failed to decode shared secret: {}", e))?;
    let key_bytes = <[u8; 32]>::try_from(secret_bytes)
        .map_err(|_| "Invalid shared secret length")?;

    let nonce_bytes = BASE64.decode(&payload.nonce)
        .map_err(|e| format!("Failed to decode nonce: {}", e))?;
    let ciphertext_bytes = BASE64.decode(&payload.ciphertext)
        .map_err(|e| format!("Failed to decode ciphertext: {}", e))?;

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("Failed to create cipher: {}", e))?;

    let nonce_arr = <[u8; 12]>::try_from(nonce_bytes)
        .map_err(|_| "Invalid nonce length")?;
    let nonce = Nonce::from_slice(&nonce_arr);

    let plaintext = cipher.decrypt(nonce, ciphertext_bytes.as_ref())
        .map_err(|e| format!("Decryption failed: {}", e))?;

    String::from_utf8(plaintext)
        .map_err(|e| format!("Failed to convert to string: {}", e))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub nonce: String,
    pub ciphertext: String,
}
