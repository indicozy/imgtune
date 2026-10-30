# Agent skill

`skills/imgtune/SKILL.md` teaches a coding agent to run ImgTune safely. It works with Claude Code and with any tool that reads
`SKILL.md` skills. It ships in the npm package under `skills/`.

To use it, copy the `skills/imgtune` folder into your agent's skills directory. The skill is on
[GitHub](https://github.com/indicozy/imgtune/tree/main/skills/imgtune).

## What the skill covers

- **A live URL.** One `scan` of a site you own. The agent reports the exact and estimated savings for each page separately, and
  says which figure is measured and which is an estimate. Sharpness growth is reported apart.
- **A Next.js project.** `audit`, then summarise `.imgtune/report.json`, then `apply`, then `verify`. The agent shows `git diff` and
  does not commit.

## Rules the skill sets

- Never hand-edit what `apply` already wrote. A raise goes through `apply --raise`.
- Use `--allow-growth` only when the user accepts heavier but sharper images.
- A loader that cannot set quality gets `sizes` changes only, and the agent says so.
- Scan only sites the user owns, and scan each one once unless asked for more.
- Do not start, stop or restart the user's dev server by hand. `audit` and `verify` manage it.
- Report a `robots` or `blocked` page as such, not as a scan error.
