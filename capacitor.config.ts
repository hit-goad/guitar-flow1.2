import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.guitarflow.player',
  appName: 'GuitarFlow',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
    captureInput: true,
  },
  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      backgroundColor: '#0e1116',
      showSpinner: false,
    },
  },
};

export default config;