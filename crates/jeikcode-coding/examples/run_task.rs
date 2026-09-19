//! One-shot coding agent — the L2 stack running a single task end-to-end against a REAL
//! provider. This is the live smoke (no mock). It AUTO-APPROVES tool calls (no human in
//! the loop), so run it deliberately.
//!
//! ```bash
//! JEIKCODE_API_KEY=sk-... \
//! JEIKCODE_BASE_URL=https://api.deepseek.com/v1 \
//! JEIKCODE_MODEL=deepseek-chat \
//! cargo run -p jeikcode-coding --example run_task -- "list the rust files and summarize the crate"
//! ```

use jeikcode_coding::{build_coding_agent, CodingAgentConfig};
use jeikcode_kernel::agent::AutoRespond;

#[tokio::main]
async fn main() {
    let task = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    let task = if task.trim().is_empty() {
        "List the files in the current directory and briefly describe the project.".to_string()
    } else {
        task
    };

    let Ok(api_key) = std::env::var("JEIKCODE_API_KEY") else {
        eprintln!("Set JEIKCODE_API_KEY (+ optional JEIKCODE_BASE_URL / JEIKCODE_MODEL) to run a live task.");
        std::process::exit(2);
    };
    let base_url = std::env::var("JEIKCODE_BASE_URL")
        .unwrap_or_else(|_| "https://api.deepseek.com/v1".to_string());
    let model = std::env::var("JEIKCODE_MODEL").unwrap_or_else(|_| "deepseek-chat".to_string());
    let cwd = std::env::current_dir().expect("cwd");

    let agent = match build_coding_agent(CodingAgentConfig::new(api_key, base_url, model, cwd)) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("build failed: {e}");
            std::process::exit(1);
        }
    };

    println!("task: {task}\n--- running ---");
    let outcome = agent.run_to_completion(task, AutoRespond::AllowAll).await;
    println!(
        "\n--- outcome ---\nstop: {:?}\ntool calls: {}\n\n{}",
        outcome.stop,
        outcome.tool_results.len(),
        outcome.text
    );
    if let Some(err) = outcome.error {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}
