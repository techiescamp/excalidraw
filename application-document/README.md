# Application document

The blueprint of this system, written so that someone who has never seen it can pick it up. If the laptop it was built on is gone, these two files plus the repository are enough to understand it and build it again.

| File | What it answers |
| --- | --- |
| [01-application.md](01-application.md) | What the application is, what it does, what we added on top of Excalidraw, how the parts talk to each other, what is in the database, how to run it locally |
| [02-server.md](02-server.md) | What the server is, who can log in to it, what runs on it, how traffic flows, how a release reaches it, how to back it up and how to rebuild it |

Two other files sit next to these and are not repeated here:

- `DEVELOPMENT.md` — how work is done: branches, checks, releases, the rules that exist because breaking them took the site down.
- `HANDOFF.md` — what has happened: the running log between whoever works here.
- `deploy.md` — the full install procedure, command by command, as it was run on the real server.

Keep these documents true. If you change how something works, change the page that describes it in the same pull request.
