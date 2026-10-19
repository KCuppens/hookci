# Example Node App

A minimal Node.js application without a `.zeroci.yml` configuration file.
It exercises `zeroci` auto-detection for npm projects:
- Detects `lint` (`npm run lint`)
- Detects `typecheck` (`npm run typecheck`)
- Detects `unit` (`npm test`)
- Executes detected check jobs in parallel under slot caps.
