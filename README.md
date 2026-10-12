# Getting Started with Create React App

This project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).

## Deployment

The React frontend runs on **Firebase Hosting** and the Flask backend runs on
**Cloud Run**, both in the same Firebase/GCP project. Releases use a
blue/green flow: a backend revision is deployed with `--no-traffic` and
verified through `/health` before traffic moves, and a frontend release is
built to a Hosting preview channel before it is cloned onto `live`.

- **[Deployment guide (GCP + Firebase blue/green)](docs/gcp-firebase-blue-green.md)** —
  required tools, one-time GCP setup, first deployment, releasing, validation
  checklist, rollback, logging, CORS, WebSockets, data-compatibility rules.
- `deployment/README.md` — the original single-service runbook.
- Deployment scripts: [`scripts/gcp/`](scripts/gcp/) (backend) and
  [`scripts/firebase/`](scripts/firebase/) (frontend). Nothing in
  `.github/workflows/` deploys to production; promotion always requires a
  human running `promote-green.ps1` or `promote-live.ps1`.
- Pull requests run [`pr-checks.yml`](.github/workflows/pr-checks.yml):
  frontend build, backend tests, and a backend container build — with no GCP or
  Firebase credentials.

Copy the placeholder templates before use (all real config files are
git-ignored): `.env.example`, `backend/.env.example`,
`scripts/gcp/config.example.ps1`, `scripts/gcp/cloudrun.env.yaml.example`,
`scripts/firebase/config.example.ps1`, `.firebaserc.example`.

## Available Scripts

In the project directory, you can run:

### `npm start`

Runs the app in the development mode.\
Open [http://localhost:3000](http://localhost:3000) to view it in your browser.

The page will reload when you make changes.\
You may also see any lint errors in the console.

### `npm test`

Launches the test runner in the interactive watch mode.\
See the section about [running tests](https://facebook.github.io/create-react-app/docs/running-tests) for more information.

### `npm run build`

Builds the app for production to the `build` folder.\
It correctly bundles React in production mode and optimizes the build for the best performance.

The build is minified and the filenames include the hashes.\
Your app is ready to be deployed!

See the section about [deployment](https://facebook.github.io/create-react-app/docs/deployment) for more information.

### `npm run eject`

**Note: this is a one-way operation. Once you `eject`, you can't go back!**

If you aren't satisfied with the build tool and configuration choices, you can `eject` at any time. This command will remove the single build dependency from your project.

Instead, it will copy all the configuration files and the transitive dependencies (webpack, Babel, ESLint, etc) right into your project so you have full control over them. All of the commands except `eject` will still work, but they will point to the copied scripts so you can tweak them. At this point you're on your own.

You don't have to ever use `eject`. The curated feature set is suitable for small and middle deployments, and you shouldn't feel obligated to use this feature. However we understand that this tool wouldn't be useful if you couldn't customize it when you are ready for it.

## Learn More

You can learn more in the [Create React App documentation](https://facebook.github.io/create-react-app/docs/getting-started).

To learn React, check out the [React documentation](https://reactjs.org/).

### Code Splitting

This section has moved here: [https://facebook.github.io/create-react-app/docs/code-splitting](https://facebook.github.io/create-react-app/docs/code-splitting)

### Analyzing the Bundle Size

This section has moved here: [https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size](https://facebook.github.io/create-react-app/docs/analyzing-the-bundle-size)

### Making a Progressive Web App

This section has moved here: [https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app](https://facebook.github.io/create-react-app/docs/making-a-progressive-web-app)

### Advanced Configuration

This section has moved here: [https://facebook.github.io/create-react-app/docs/advanced-configuration](https://facebook.github.io/create-react-app/docs/advanced-configuration)

### Deployment

This section has moved here: [https://facebook.github.io/create-react-app/docs/deployment](https://facebook.github.io/create-react-app/docs/deployment)

### `npm run build` fails to minify

This section has moved here: [https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify](https://facebook.github.io/create-react-app/docs/troubleshooting#npm-run-build-fails-to-minify)
