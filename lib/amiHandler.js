/**
 * AMI handler: faz o bind dos eventos relevantes e atualiza o 'state' em memória.
 */
export function createAmiHandler({ host, port, username, password, state, onUpdate }) {
  function setPeer(id, patch) {
    const prev = state.peers.get(id) || {};
    const next = { ...prev, ...patch, lastSeen: Date.now() };
    state.peers.set(id, next);
    onUpdate({ type: 'PeerStatus', peer: id, data: next, source: host });
  }

  function setCall(uniqueid, patch) {
    const prev = state.calls.get(uniqueid) || {};
    const next = { ...prev, ...patch };
    state.calls.set(uniqueid, next);
    onUpdate({ type: 'Call', id: uniqueid, data: next, source: host });
  }

  function removeCall(uniqueid, reason='hangup') {
    const data = state.calls.get(uniqueid);
    state.calls.delete(uniqueid);
    onUpdate({ type: 'CallEnd', id: uniqueid, data, reason, source: host });
  }

  return {
    bind(client) {
      // Status inicial dos peers
      client.action({ Action: 'SIPshowpeers' }).catch(()=>{});

      client.on('event', (evt) => {
        const name = (evt.Event || '').toLowerCase();

        // Peer status (SIP/PJSIP)
        if (name === 'peerstatus') {
          const peer = evt.Peer || evt.PeerStatus || evt.EndpointName || evt.Channel;
          const status = evt.PeerStatus || evt.Status || evt.PeerStatusText || evt.PeerStatusStr || evt.StatusText;
          if (peer) setPeer(peer, { status: status || 'Unknown', tech: evt.ChannelType || evt.ChannelDriver });
        }

        // Newchannel → nova chamada
        if (name === 'newchannel') {
          if (!evt.Uniqueid) return;
          setCall(evt.Uniqueid, {
            src: evt.CallerIDNum || evt.CallerID || evt.CallerIDName,
            channel: evt.Channel,
            startedAt: Date.now(),
            state: evt.ChannelStateDesc || 'Unknown'
          });
        }

        // Newstate (Ringing/Up/etc)
        if (name === 'newstate') {
          if (!evt.Uniqueid) return;
          setCall(evt.Uniqueid, { state: evt.ChannelStateDesc });
        }

        // BridgeEnter/Leave → ligação estabelecida/terminando ponte
        if (name === 'bridgeenter') {
          const uid = evt.Uniqueid1 || evt.Uniqueid || evt.BridgeUniqueid;
          if (uid) setCall(uid, { bridged: true });
        }
        if (name === 'bridgeleave') {
          const uid = evt.Uniqueid1 || evt.Uniqueid || evt.BridgeUniqueid;
          if (uid) setCall(uid, { bridged: false });
        }

        // Hangup
        if (name === 'hangup') {
          if (!evt.Uniqueid) return;
          removeCall(evt.Uniqueid, evt.Cause || 'hangup');
        }

        // Registry → status de trunks
        if (name === 'registry') {
          const trunk = evt.Channel || evt.Domain || evt.Username || evt.Host;
          const status = evt.Status || evt.Message || evt.ReplyText;
          if (trunk) setPeer(trunk, { status: `REGISTRY ${status || ''}`.trim(), tech: 'TRUNK' });
        }
      });
    }
  };
}
