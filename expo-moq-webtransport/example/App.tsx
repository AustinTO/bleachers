import React, { useState } from 'react';
import { Button, SafeAreaView, Text, View } from 'react-native';
import { MoqtConnection } from '@moqt/webtransport';
import {
  assertDraft16,
  createCloudflareDraft16Transport,
} from 'expo-moq-webtransport';

// Supply a short-lived Cloudflare MoQ token from your own auth flow.
const TOKEN = 'REPLACE_WITH_TOKEN';

export default function App() {
  const [status, setStatus] = useState('idle');

  const connect = async () => {
    setStatus('connecting');
    const wt = createCloudflareDraft16Transport(TOKEN);
    try {
      await assertDraft16(wt);

      const moq = new MoqtConnection(16);
      await moq.connect(wt);

      setStatus(
        `MOQT draft ${moq.draftVersion} connected; ` +
          `WT=${wt.protocol}; datagram max=${wt.datagrams.maxDatagramSize}`,
      );

      // Next: subscribe/publish with the @moqt/webtransport connection.
    } catch (e) {
      setStatus(String(e));
      wt.close();
    }
  };

  return (
    <SafeAreaView>
      <View style={{ padding: 24, gap: 16 }}>
        <Text>Expo native MoQT/WebTransport draft-16 smoke test</Text>
        <Text selectable>{status}</Text>
        <Button title="Connect to Cloudflare MoQ" onPress={connect} />
      </View>
    </SafeAreaView>
  );
}
