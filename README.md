# 📡 Monitor Azcall
### Serviço de Monitoramento em Tempo Real — Asterisk (AMI + WebSocket)

---

## Visão Geral

O **Monitor Azcall3** é um microserviço independente para monitoramento em tempo real de **ramais, troncos e chamadas** do Asterisk via **AMI**.  
Ele coleta eventos do PBX, organiza o estado em memória e publica atualizações para o **painel WebSocket (front Frest)**, exibindo o status dos ramais e troncos sem necessidade de recarregar a página.

Este módulo pode ser **instalado e ativado por cliente**, sem alterar o core do Azcall3.

Preview do painel:
![Preview do Monitor Azcall](https://raw.githubusercontent.com/isoazevedo/monitor-azcall/refs/heads/main/img/monitor_de_ramais.png)

---

## Estrutura do Projeto

```
/opt/monitor-azcall/
 ├── monitor-service.js      # Serviço principal (Node.js + AMI + WS)
 ├── .env                    # Configurações de porta e AMI
 ├── public/                 # Painel web (Frest-style)
 │    ├── index.html
 │    ├── monitor.js
 │    └── styles.css
 └── systemd/
      └── monitor-azcall.service
```

---

## Configuração

### `.env`
```bash
# Examplo de configuração environment para Monitor AzCall
PORT=5120
PUBLISH_MODE=socket
SOCKET_NAMESPACE=/monitor
ALLOW_ORIGIN=*

# Configuração Asterisk Manager Interface (AMI) - pode ser múltiplos hosts separados por vírgula
AMI_HOSTS=127.0.0.1
AMI_PORT=5038
AMI_USER=usuario_ami
AMI_PASS=senha_ami

# Redis (se quiser implementar o modo redis)
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_CHANNEL=monitor-events
```

### Apache Proxy (com SSL e WebSocket)

```apache
ProxyPass        "/monitor/"  "http://127.0.0.1:5120/"
ProxyPassReverse "/monitor/"  "http://127.0.0.1:5120/"
```

- Painel: `https://seudominio.com/monitor/`
- WebSocket: `wss://seudominio.com/monitor`

---

## Funcionalidades

| Categoria | Recursos |
|------------|-----------|
| **Ramais** | Listagem automática via `PJSIPShowEndpoints` + atualização por eventos `PeerStatus` |
| **Troncos SIP** | Listagem via `PJSIPShowRegistrationsOutbound` |
| **Troncos IAX2** | Coleta via `IAXpeerlist` (eventos `PeerEntry`, `PeerlistComplete`) |
| **Chamadas ativas** | Identificação via `CoreShowChannels` e eventos `NewChannel`, `Hangup`, `BridgeEnter`, `BridgeLeave` |
| **Conexão WS** | Broadcast em tempo real + reconexão automática no front |
| **Front-end** | Painel leve em Frest (Bootstrap 5 + BoxIcons + Grid responsivo) |
| **Status visual** | Online/Offline, Registrado, Em chamada, Desconectado |

---

## Funcionamento

1. Conecta ao AMI dos hosts definidos em `.env`.
2. Executa as ações iniciais:
    - `PJSIPShowEndpoints`
    - `PJSIPShowRegistrationsOutbound`
    - `IAXpeerlist`
    - `CoreShowChannels`
3. Mantém um estado em memória (`Map`) com:
   ```js
   state = {
     peers: Map(), // ramais
     trunks: Map(), // troncos
     calls: Map()  // chamadas ativas
   }
   ```
4. Emite via WebSocket (`broadcast(event, data)`) todos os updates:
    - `InitialState`
    - `PeerStatus`
    - `Registry`
    - `NewCall`, `CallState`, `CallEnded`
    - `BridgeEnter`, `BridgeLeave`

---

## Front-end (public/)

### `index.html`
Interface Moderna com:
- Navbar fixa (`Monitor Azcall`)
- Colunas:
    - **Ramais e Agentes**
    - **Troncos**
    - **Chamadas Ativas**
- Indicadores de status (badges coloridas)
- Rodapé com créditos

### `monitor.js`
Lógica do painel:
- Conecta via WebSocket ao backend (`/monitor`)
- Recebe e trata os eventos AMI
- Renderiza em tempo real os elementos
- Reconnection automática com contador de tentativas

Exemplo do mecanismo de reconexão:
```js
ws.onclose = () => {
  if (reconnectAttempts < maxReconnect) {
    reconnectAttempts++;
    statusEl.textContent = `Reconectando (${reconnectAttempts})...`;
    setTimeout(connectWS, 3000);
  } else {
    statusEl.textContent = "Desconectado";
  }
};
```
Backend com ciclo de atualização a cada 5 segundos para renovar o estado visual.


### `styles.css`
- Base (Bootstrap 5)
- Layout em grid (`col-md-4`) — 3 ramais por linha
- Badges com cores dinâmicas (`bg-success`, `bg-danger`, `bg-secondary`, `bg-warnig`)
- Efeitos sutis de hover e sombra

---

## Integração com Azcall PbxIp

O monitor pode ser embutido como página no painel do Azcall PbxIp via iframe:

```html
<iframe src="https://seudominio.com/monitor/" 
        style="border:0;width:100%;height:calc(100vh - 80px);"></iframe>
```

Ou adicionado no menu supervisor:

```php
<li class="nav-item">
  <a href="https://seudominio.com/monitor/" target="_blank" class="nav-link">
    <i class="bx bx-pulse"></i>
    <span>Monitoramento</span>
  </a>
</li>
```

Desativar o módulo → basta ocultar o menu.

---

## Eventos Principais AMI

| Evento | Descrição |
|--------|------------|
| `PeerStatus` | Atualiza status de ramal (OK, Unreachable, etc.) |
| `Registry` | Atualiza registro de tronco |
| `Newchannel` | Nova chamada iniciada |
| `Newstate` | Mudança de estado da chamada |
| `BridgeEnter / BridgeLeave` | Entrou ou saiu de uma ponte |
| `Hangup` | Chamada finalizada |
| `CoreShowChannel` | Chamada ativa detectada no carregamento inicial |
| `PeerEntry` (IAX2) | Tronco ou peer IAX detectado |

---

## Classificação de Endpoints

| Tipo | Critério                 |
|------|--------------------------|
| **SIP Ramal** | `Description == "0"`     |
| **PJSIP Ramal** | `OutboundAuths == "0"`   |
| **PJSIP Tronco** | `OutboundAuths != "0"`   |
| **SIP Tronco** | `Description == "trunk"` |
| **IAX Tronco** | `ChannelType == "IAX2"`  |

---

## Resiliência

- Reconexão automática (Node e Front)
- Múltiplos AMI hosts simultâneos
- Estado em memória limpo e consistente
- Atualização de status via broadcast contínuo

---

## Licença 

Este projeto é licenciado sob a Licença MIT - veja o arquivo [LICENSE](LICENSE) para detalhes.

---

## Contribuição

Contribuições são bem-vindas! Por favor, sinta-se à vontade para fazer um fork, envie um pull request ou abra uma issue para discutir melhorias ou bugs.

---

## Contato
Para dúvidas, sugestões ou suporte, entre em contato:
- **Email:** [israel@aztell.com.br](mailto:israel@aztell.com.br)
- **Site:** [portcallvoip.com.br](https://portcallvoip.com.br)
- **GitHub:** [Israel Azevedo](https://github.com/isoazevedo)
- **Whatsapp:** [Clique aqui](https://wa.me/556191562005)

## Créditos

> Sistema desenvolvido por **Israel Azevedo** (Aztell soluções em telefonia IP)
>
> Versão: `v1.0.0`  
> Data: Outubro/2025

---

## Doações
Se este projeto lhe ajudou, considere fazer uma doação para apoiar o desenvolvimento contínuo:
- **Link para Doação:** [Doe via Pix](https://link.mercadopago.com.br/isoazevedo)

### “A estabilidade nasce do monitoramento — e o Azcall agora enxerga tudo em tempo real.”
