//! Soft mid-turn steer text.
//!
//! A queued follow-up can be folded into the *current* turn at the next round
//! boundary (after the in-flight model call or tool batch finishes) without
//! cancelling that work. The user text stays first so it is a real instruction;
//! the note only tells the model when to apply it. The marker is stripped in the
//! WebUI, so the bubble shows the user's words, not the note.

pub const STEER_MARKER: &str = "[jeikcode-steer]";

const STEER_NOTE: &str = "\
The user sent the instruction above while this turn was still running. \
Do not interrupt a tool call that is already in flight, and do not discard useful progress. \
On your next step, adjust direction to follow that instruction. \
If it conflicts with the earlier plan, the newer instruction wins.";

const STEER_NOTE_IMAGES_ONLY: &str = "\
The user attached new images while this turn was still running. \
Do not interrupt a tool call that is already in flight, and do not discard useful progress. \
On your next step, adjust direction to follow what those images show. \
If that conflicts with the earlier plan, the newer instruction wins.";

/// User text first, then a short course-correction note. Empty text still carries
/// the note so an image-only steer is not a blank user turn.
pub fn compose_steer_text(user_text: &str) -> String {
    let body = user_text.trim();
    if body.is_empty() {
        format!("{STEER_MARKER}\n{STEER_NOTE_IMAGES_ONLY}")
    } else {
        format!("{body}\n\n{STEER_MARKER}\n{STEER_NOTE}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steer_keeps_user_text_ahead_of_the_note() {
        let text = compose_steer_text("  改用 sqlite，不要继续写 json  ");
        assert!(text.starts_with("改用 sqlite，不要继续写 json\n\n[jeikcode-steer]\n"));
        assert!(text.contains("Do not interrupt a tool call"), "{text}");
        assert!(text.contains("newer instruction wins"), "{text}");
    }

    #[test]
    fn image_only_steer_still_explains_the_course_correction() {
        let text = compose_steer_text("   ");
        assert!(text.starts_with("[jeikcode-steer]\n"));
        assert!(text.contains("attached new images"));
    }
}
