# Contributing to PrintBinder

Thank you for wanting to help. PrintBinder is maintained by one person, so the most useful contributions are clear reports of what went wrong and what is missing.

## Reporting a problem or asking for something

- In the program: **Help > Give feedback**.
- Here: open an issue and pick "Something is broken" or "An idea".

A good report says what you did, what you expected, what happened instead, and which version you have (Help > About). A screenshot helps. Please do not attach your model files or anything private; a description is enough.

Security problems: see [SECURITY.md](SECURITY.md) and do not open a public issue.

## The rules the program keeps

Any change has to keep these. They are the reason people can trust it with their files.

1. Nothing is moved, renamed or removed until the owner approves it.
2. "Remove" never deletes. Files go to a holding folder inside the library.
3. Every action can be undone.
4. A move between drives is copied, checked byte for byte, and only then removed from the old place.
5. The program listens on this computer only (127.0.0.1) unless the owner switches on phone access.
6. Nothing is sent to an AI service unless the owner presses a button or sends a message, and model files are never sent.
7. API keys stay on the computer they were entered on. They are never written into the library, and never handed back to the page.
8. No account, no sign-in, no telemetry.
9. No prices or cost estimates in the program. Prices change.

## Changing the code

1. Open an issue first for anything larger than a small fix, so effort is not wasted on something that will not be merged.
2. Fork, make a branch, and keep the change to one thing.
3. `npm install`, then `npm start` to run from source. Use a throwaway folder of models as the library, never your real one.
4. Try what you changed by hand, including Undo. Say in the pull request what you tried and what you did not.
5. Use plain words in anything the user reads.
6. Do not add a dependency without saying why. Anything bundled must have a licence that allows it, and `npm run notices` must be run afterwards.

The file list in the README says what lives where. The name, maker and addresses live only in `brand.js`.

## Licence

PrintBinder is under the MIT licence. By contributing you agree that your contribution is under the same licence.
