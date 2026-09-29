//! Soft mid-turn steer text with structured `<user-query>` and lightweight English guidance.
//!
//! A queued follow-up is folded into the *current* turn at the next round boundary
//! (after the in-flight model call or tool batch finishes) without cancelling that work.
//! The user text is wrapped in `<user-query>`, followed by actionable steering principles.
//! The envelope is stripped in the WebUI and other client views so the displayed bubble
//! only shows the user's original words.

pub const STEER_MARKER: &str = "[jeikcode-steer]";

pub const STEER_GUIDELINES: &str = "\
You are currently in the middle of executing a task. The user has sent the new request above. Please follow these principles:
1. If the new direction does not conflict with the current task, first briefly acknowledge the user's request and concerns. Elevate the priority of the user's new direction, and prioritize completing the new direction at an appropriate task juncture before completing the original request. You do not necessarily have to wait until the current task is completely finished; you can integrate the new direction into a revised plan midway. If the current task is in the unit testing stage, stop testing first and switch to the new direction.
2. If the current task conflicts with the new direction, wrap up the original task in the cleanest, most concise manner to ensure no broken state, and promptly address the user's new task.";

pub const STEER_GUIDELINES_IMAGES_ONLY: &str = "\
You are currently in the middle of executing a task. The user has attached new image(s) above. Please follow these principles:
1. If the new direction does not conflict with the current task, first briefly acknowledge the user's request and concerns. Elevate the priority of the user's new direction, and prioritize completing the new direction at an appropriate task juncture before completing the original request. You do not necessarily have to wait until the current task is completely finished; you can integrate the new direction into a revised plan midway. If the current task is in the unit testing stage, stop testing first and switch to the new direction.
2. If the current task conflicts with the new direction, wrap up the original task in the cleanest, most concise manner to ensure no broken state, and promptly address the user's new task.";

/// Check if text has already been wrapped with `<user-query>...</user-query>`.
pub fn is_steer_wrapped(text: &str) -> bool {
    text.contains("<user-query>") && text.contains("</user-query>")
}

/// Formats mid-turn steer text wrapping the user input in `<user-query>` and appending English guidelines.
pub fn compose_steer_text(user_text: &str) -> String {
    let body = user_text.trim();
    if is_steer_wrapped(body) {
        return body.to_string();
    }
    if body.is_empty() {
        format!("<user-query>\n(The user attached image(s))\n</user-query>\n\n{STEER_MARKER}\n{STEER_GUIDELINES_IMAGES_ONLY}")
    } else {
        format!("<user-query>\n{body}\n</user-query>\n\n{STEER_MARKER}\n{STEER_GUIDELINES}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steer_wraps_user_text_in_query_tag_with_english_principles() {
        let text = compose_steer_text("  use sqlite instead of json  ");
        assert!(text.starts_with("<user-query>\nuse sqlite instead of json\n</user-query>\n\n[jeikcode-steer]\n"));
        assert!(text.contains("If the new direction does not conflict with the current task"));
        assert!(text.contains("If the current task is in the unit testing stage, stop testing first"));
        assert!(text.contains("wrap up the original task in the cleanest, most concise manner"));
    }

    #[test]
    fn image_only_steer_still_explains_the_course_correction() {
        let text = compose_steer_text("   ");
        assert!(text.starts_with("<user-query>\n(The user attached image(s))\n</user-query>\n\n[jeikcode-steer]\n"));
        assert!(text.contains("user has attached new image(s) above"));
    }

    #[test]
    fn does_not_double_wrap_already_wrapped_text() {
        let wrapped = "<user-query>\nfoo\n</user-query>\n\n[jeikcode-steer]\nnotes";
        assert_eq!(compose_steer_text(wrapped), wrapped);
    }
}
