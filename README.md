# Programmatic CI Failure Helper

GitHub Action that inspects the current workflow run, confirms it failed, finds the latest failed job/step, tails its logs, and asks OpenRouter for likely fixes. Output goes to the action log and, if the run is tied to a pull request, a PR comment is created/updated.

## Inputs
- `openrouter_api_key` (required): OpenRouter API key.
- `model` (required): OpenRouter model name (e.g., `x-ai/grok-4.1-fast:free`).
- `prompt_template` (required): Must include `{{LOG}}`; optional placeholders: `{{WORKFLOW_NAME}}`, `{{JOB_NAME}}`, `{{STEP_NAME}}`.
- `max_log_lines` (optional, default 500): Tail lines included from the failed job log.

## Example workflow (single job with failing step)
```yaml
name: AI CI Failure Demo

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  fail-demo:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      pull-requests: write
    steps:
      - name: Step 1 - always succeeds
        run: echo "Hello from the first step"

      - name: Step 2 - broken docker build (fails intentionally)
        run: docker build -t invalid-image ./does-not-exist

      - name: Step 3 - AI failure helper
        if: always()
        uses: your-org/actions-progci-fail@v0.1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          model: x-ai/grok-4.1-fast:free
          prompt_template: |
            Workflow {{WORKFLOW_NAME}} failed at job {{JOB_NAME}}, step {{STEP_NAME}}.
            Last log lines:
            {{LOG}}

            Explain the likely root cause and suggest concrete fixes.
          max_log_lines: 200
```

## Notes
- Use `if: always()` on the helper step so it runs even when previous steps fail.
- Helper runs only when the workflow conclusion is non-success; it must find a failed job/step and fetch its logs.
- If the run is associated with a PR, the helper posts/updates a PR comment tagged with `<!-- ai-ci-helper -->`.
- The action tails the latest failed job/step; secrets are not logged and logs are trimmed to `max_log_lines`.
