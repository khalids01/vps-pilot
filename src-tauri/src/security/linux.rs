//! Linux local-user authentication through the system PAM stack, without elevating the app or spawning a shell.
use nix::unistd::{geteuid, getuid, User};
use pam_client::{Context, ConversationHandler, ErrorCode, Flag};
use std::{
    ffi::{CStr, CString},
    os::unix::fs::MetadataExt,
};
use zeroize::Zeroizing;

const SERVICE: &str = "login";
const FAILURE: &str = "Linux login authentication failed. Check your device login password and account status. This PAM policy may require an unsupported authentication method.";

pub fn account() -> Result<String, String> {
    let uid = getuid();
    if uid.is_root() || uid != geteuid() {
        return Err("Run VPS Pilot as your normal Linux user to enable device lock.".into());
    }
    User::from_uid(uid)
        .map_err(|_| "Cannot identify the current Linux user.")?
        .filter(|user| user.uid == uid && !user.name.is_empty())
        .map(|user| user.name)
        .ok_or_else(|| "Cannot identify the current Linux user.".into())
}

pub fn available() -> Result<String, String> {
    let account = account()?;
    let policy = std::fs::metadata("/etc/pam.d/login").map_err(|_| {
        "Linux device lock requires the system PAM login policy (/etc/pam.d/login)."
    })?;
    if !policy.is_file() || policy.uid() != 0 || policy.mode() & 0o022 != 0 {
        return Err("The system PAM login policy must be a root-owned file without group or other write access.".into());
    }
    Ok(account)
}

struct PasswordConversation {
    username: String,
    password: Option<Zeroizing<String>>,
    supplied: bool,
}
impl ConversationHandler for PasswordConversation {
    fn prompt_echo_on(&mut self, _prompt: &CStr) -> Result<CString, ErrorCode> {
        CString::new(self.username.as_bytes()).map_err(|_| ErrorCode::CONV_ERR)
    }
    fn prompt_echo_off(&mut self, _prompt: &CStr) -> Result<CString, ErrorCode> {
        // Do not submit the same secret to a second factor or an unknown subsequent prompt.
        let password = self.password.take().ok_or(ErrorCode::CONV_ERR)?;
        let response = CString::new(password.as_bytes()).map_err(|_| ErrorCode::CONV_ERR)?;
        self.supplied = true;
        Ok(response)
    }
    fn text_info(&mut self, _message: &CStr) {}
    fn error_msg(&mut self, _message: &CStr) {}
}

pub fn authenticate(password: Zeroizing<String>) -> Result<(), String> {
    if password.is_empty() || password.len() > 4096 || password.contains('\0') {
        return Err("Enter your Linux login password (up to 4096 bytes).".into());
    }
    let username = available()?;
    let conversation = PasswordConversation {
        username: username.clone(),
        password: Some(password),
        supplied: false,
    };
    let mut context = Context::new(SERVICE, Some(&username), conversation).map_err(|_| FAILURE)?;
    context
        .authenticate(Flag::DISALLOW_NULL_AUTHTOK)
        .map_err(|_| FAILURE)?;
    context.acct_mgmt(Flag::NONE).map_err(|_| FAILURE)?;
    // A permissive/passwordless policy or a module switching users must never unlock the app.
    if !context.conversation().supplied || context.user().map_err(|_| FAILURE)? != username {
        return Err(FAILURE.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_is_used_once_and_not_replayed_to_another_factor() {
        let mut conversation = PasswordConversation {
            username: "fixture-user".into(),
            password: Some(Zeroizing::new("fixture-only".into())),
            supplied: false,
        };
        let prompt = c"Password:";
        assert_eq!(
            conversation.prompt_echo_on(prompt).unwrap().to_bytes(),
            b"fixture-user"
        );
        assert_eq!(
            conversation.prompt_echo_off(prompt).unwrap().to_bytes(),
            b"fixture-only"
        );
        assert!(conversation.supplied);
        assert!(conversation.password.is_none());
        assert_eq!(
            conversation.prompt_echo_off(prompt).unwrap_err(),
            ErrorCode::CONV_ERR
        );
    }
    #[test]
    fn invalid_secrets_are_rejected_before_starting_pam() {
        for password in [String::new(), "bad\0input".into(), "x".repeat(4097)] {
            assert!(authenticate(Zeroizing::new(password))
                .unwrap_err()
                .starts_with("Enter your Linux login password"));
        }
    }
}
