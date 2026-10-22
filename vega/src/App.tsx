import * as React from 'react';
import {useEffect, useRef, useState} from 'react';
import {AppState, AppStateStatus, Pressable, StyleSheet, Text, View} from 'react-native';
import {WebView} from '@amazon-devices/webview';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';
import {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMethods,
} from '@amazon-devices/webview/dist/types/WebViewTypes';
import {GAME_URL} from './config';

// Defined before the game boots so it detects the TV platform on first load.
const NATIVE_BRIDGE =
  "window.SkrienNative={platform:function(){return 'vega-os'},version:function(){return '0.3.0'}};" +
  "document.documentElement.dataset.platform='vega-os';true;";
const PAUSE_GAME =
  '(function(){var app=window.SKRIEN||window.MOVA;if(app&&app.pause)app.pause();})();true;';
const GAME_PAGE = GAME_URL.split(/[?#]/)[0];

// onError also fires for failed subresources (relay probes, fetches); only the page itself is fatal.
const isGamePage = (url: string) => url.split(/[?#]/)[0] === GAME_PAGE;

/** SKRIEN inside Amazon's vegaWebview template. */
export const App = () => {
  const web = useRef<WebViewMethods | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  usePreventHideSplashScreen();
  const hideSplashScreen = useHideSplashScreenCallback();

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state !== 'active') web.current?.injectJavaScript(PAUSE_GAME);
    });
    return () => subscription.remove();
  }, []);

  return (
    <View style={styles.screen}>
      <WebView
        key={attempt}
        ref={web}
        style={styles.webview}
        source={{uri: GAME_URL}}
        allowSystemKeyEvents
        domStorageEnabled
        hasTVPreferredFocus={!error}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="compatibility"
        injectedJavaScriptBeforeContentLoaded={NATIVE_BRIDGE}
        onLoad={() => {
          setError(false);
          web.current?.injectJavaScript(NATIVE_BRIDGE);
          hideSplashScreen();
        }}
        onError={({nativeEvent: {code, url, description}}: WebViewErrorEvent) => {
          console.error(`[SKRIEN] load error ${code} ${url}: ${description}`);
          if (!isGamePage(url)) return;
          setError(true);
          hideSplashScreen();
        }}
        onHttpError={({nativeEvent: {url, statusCode, description}}: WebViewHttpErrorEvent) => {
          console.error(`[SKRIEN] HTTP ${statusCode} ${url}: ${description}`);
        }}
      />
      {error && (
        <View style={styles.error}>
          <Text style={styles.title}>SKRIEN could not open</Text>
          <Text style={styles.body}>Check the game address or rebuild the bundled assets, then try again.</Text>
          <Pressable
            hasTVPreferredFocus
            style={styles.button}
            onPress={() => {
              setError(false);
              setAttempt(attempt + 1);
            }}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#10151a'},
  webview: {flex: 1, backgroundColor: '#10151a'},
  error: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#10151a',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 64,
  },
  title: {fontSize: 42, fontWeight: '700', color: '#ffffff', marginBottom: 20},
  body: {fontSize: 24, color: '#c2c9c4', textAlign: 'center', marginBottom: 30},
  button: {backgroundColor: '#cbff71', borderRadius: 12, paddingHorizontal: 32, paddingVertical: 18},
  buttonText: {color: '#10151a', fontSize: 24, fontWeight: '700'},
});

export default App;
