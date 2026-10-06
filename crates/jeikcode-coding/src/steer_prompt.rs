//! Soft mid-turn steer text with structured `<user-query>` and lightweight English guidance.
//!
//! A queued follow-up is folded into the *current* turn at the next round boundary
//! (after the in-flight model call or tool batch finishes) without cancelling that work.
//! The user text is wrapped in `<user-query>`, followed by actionable steering principles.
//! The envelope is stripped in the WebUI and other client views so the displayed bubble
//! only shows the user's original words.

pub const STEER_MARKER: &str = "[jeikcode-steer]";

pub const STEER_GUIDELINES: &str = "\
You are currently in the middle of executing a task. The user has sent the new request above. Follow these execution principles:
1. Acknowledge and Retain by Default:
   Briefly acknowledge the user's new request. Unless the user explicitly instructs to cancel or discard the previous task (e.g., \"abort\", \"drop previous\", \"cancel\"), NEVER discard or clear existing tasks or TodoLists.
2. TodoList Priority Injection and Safe Transition:
   - If a TodoList exists, elevate the new request's priority and insert it ahead of pending tasks at an appropriate slot.
   - Clean Transition: Do not switch mid-edit. Bring the current item to a clean, non-broken, syntactically valid checkpoint before switching.
   - Automatic Resumption: Once the new request is completed, automatically resume and complete the remaining original tasks in the list.
3. Testing Phase Fast-path:
   If the original task is substantially implemented and currently undergoing tests, pause testing immediately and pivot to the new request. Run a unified verification covering both old and new tasks once the new request is implemented.
4. Surgical Conflict Replacement:
   If the new request conflicts with specific sub-tasks of the original plan (e.g., modifying B instead of A), surgically replace only the conflicting items with the new requirements, while preserving all non-conflicting original tasks.";

pub const STEER_GUIDELINES_IMAGES_ONLY: &str = "\
You are currently in the middle of executing a task. The user has attached new image(s) above. Follow these execution principles:
1. Acknowledge and Retain by Default:
   Briefly acknowledge the user's new input. Unless the user explicitly instructs to cancel or discard the previous task (e.g., \"abort\", \"drop previous\", \"cancel\"), NEVER discard or clear existing tasks or TodoLists.
2. TodoList Priority Injection and Safe Transition:
   - If a TodoList exists, elevate the new input's priority and insert it ahead of pending tasks at an appropriate slot.
   - Clean Transition: Do not switch mid-edit. Bring the current item to a clean, non-broken, syntactically valid checkpoint before switching.
   - Automatic Resumption: Once the new input is addressed, automatically resume and complete the remaining original tasks in the list.
3. Testing Phase Fast-path:
   If the original task is substantially implemented and currently undergoing tests, pause testing immediately and pivot to the new input. Run a unified verification covering both old and new tasks once the new input is addressed.
4. Surgical Conflict Replacement:
   If the new input conflicts with specific sub-tasks of the original plan (e.g., modifying B instead of A), surgically replace only the conflicting items with the new requirements, while preserving all non-conflicting original tasks.";

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
        assert!(text.starts_with(
            "<user-query>\nuse sqlite instead of json\n</user-query>\n\n[jeikcode-steer]\n"
        ));
        assert!(text.contains("Acknowledge and Retain by Default"));
        assert!(text.contains("TodoList Priority Injection and Safe Transition"));
        assert!(text.contains("Testing Phase Fast-path"));
        assert!(text.contains("Surgical Conflict Replacement"));
    }

    #[test]
    fn image_only_steer_still_explains_the_course_correction() {
        let text = compose_steer_text("   ");
        assert!(text.starts_with(
            "<user-query>\n(The user attached image(s))\n</user-query>\n\n[jeikcode-steer]\n"
        ));
        assert!(text.contains("user has attached new image(s) above"));
        assert!(text.contains("Acknowledge and Retain by Default"));
    }

    #[test]
    fn does_not_double_wrap_already_wrapped_text() {
        let wrapped = "<user-query>\nfoo\n</user-query>\n\n[jeikcode-steer]\nnotes";
        assert_eq!(compose_steer_text(wrapped), wrapped);
    }
}
