These unmodified output schemas were retrieved on 2026-09-08 from:
- https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/post-tool-use.command.output.schema.json
- https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/user-prompt-submit.command.output.schema.json

They enforce the host contract in offline regression tests, including rejection of the former top-level additionalContext field.
