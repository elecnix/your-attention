// Stories for the built-in page. They render the page's own components with the
// React inside the OpenUI browser bundle, which preview-head.html loads.
export default {
  framework: { name: '@storybook/html-vite', options: {} },
  stories: ['../web/stories/*.stories.js'],
  staticDirs: [{ from: '../node_modules/@openuidev/browser-bundle/dist', to: '/vendor' }, { from: '../web', to: '/web' }],
  core: { disableTelemetry: true },
};
