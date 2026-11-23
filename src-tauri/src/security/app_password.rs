use argon2::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Argon2, Params,
};

pub fn validate_new(password: &str) -> Result<(), String> {
    if password.chars().count() < 8 || password.len() > 4096 || password.contains('\0') {
        return Err("Use at least 8 characters, up to 4096 bytes.".into());
    }
    Ok(())
}
pub fn validate_hash(encoded: &str) -> Result<(), String> {
    if encoded.len() > 256 {
        return Err("Invalid app password data.".into());
    }
    let hash = PasswordHash::new(encoded).map_err(|_| "Invalid app password data.")?;
    let params = Params::try_from(&hash).map_err(|_| "Invalid app password data.")?;
    if hash.algorithm.as_str() != "argon2id"
        || hash.version != Some(19)
        || params.m_cost() != Params::DEFAULT_M_COST
        || params.t_cost() != Params::DEFAULT_T_COST
        || params.p_cost() != Params::DEFAULT_P_COST
        || hash.hash.as_ref().is_none_or(|output| output.len() != 32)
        || hash.salt.is_none()
    {
        return Err("Unsupported app password data.".into());
    }
    Ok(())
}
pub fn hash(password: &str) -> Result<String, String> {
    validate_new(password)?;
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| "Cannot protect the app password.".into())
}
pub fn verify(password: &str, encoded: &str) -> Result<(), String> {
    if password.is_empty() || password.len() > 4096 {
        return Err("Incorrect password.".into());
    }
    validate_hash(encoded)?;
    Argon2::default()
        .verify_password(password.as_bytes(), encoded)
        .map_err(|_| "Incorrect password.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn salted_hashes_verify_only_the_correct_password() {
        let first = hash("fixture-password-one").unwrap();
        let second = hash("fixture-password-one").unwrap();
        assert_ne!(first, second);
        validate_hash(&first).unwrap();
        assert!(verify("fixture-password-one", &first).is_ok());
        assert!(verify("fixture-password-two", &first).is_err());
        assert!(!first.contains("fixture-password-one"));
    }
    #[test]
    fn invalid_input_and_unbounded_hash_parameters_are_rejected() {
        assert!(hash("short").is_err());
        assert!(hash("has\0invalid-password").is_err());
        assert!(hash(&"x".repeat(4097)).is_err());
        let encoded = hash("fixture-password-two").unwrap();
        assert!(validate_hash(&encoded.replace("m=19456", "m=99999999")).is_err());
        assert!(validate_hash("invalid").is_err());
    }
}
