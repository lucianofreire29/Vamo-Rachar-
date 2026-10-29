# Contrato de API — Integração Front-end e Back-end (Vamo Rachar)

Este documento descreve como o repositório `vamo-rachar-front` deve comunicar com a API HTTP do Back-end (`functions/src/server.js`).

## 1. Endereços Base (Base URL)

- **Ambiente Local**: `http://localhost:3000`
- **Ambiente de Protótipo (Render)**: `https://vamo-rachar.onrender.com`
- **Verificação de disponibilidade do servidor**: `GET /health` -> Retorna `200 OK` com `{ "status": "ok" }`.

## 2. Autenticação e Cabeçalhos Obrigatórios

Todas as operações de negócio utilizam o método `POST` no padrão `/api/:operation` e exigem um **ID Token do Firebase Authentication** (incluindo login anônimo `signInAnonymously` para clientes na mesa):

- **URL**: `POST /api/<operation>`
- **Header 1**: `Content-Type: application/json`
- **Header 2**: `Authorization: Bearer <FIREBASE_ID_TOKEN>`

### Formato Padrão de Resposta
- **Sucesso (`200 OK`)**: `{ "result": { ...dados } }`
- **Erro (`400`, `401`, `403`, `404`, `409`, `429`, `500`)**: `{ "error": "<codigo-do-erro>", "message": "<mensagem-legivel>" }`

## 3. Dados Padrão do Ambiente de Demonstração (Seed)

Gerados pelo script `scripts/seed-prototipo.cjs`:
- **`restaurantId`**: `"restaurante-demo"`
- **`tableId`**: `"mesa-13"` (também disponíveis `"mesa-01"` a `"mesa-20"`)
- **`sessionId` inicial da Mesa 13**: `"sessao-mesa-13-ativa"`
- **Itens do cardápio (`menuItemId`)**: `"fries"` (3600 centavos), `"burger"` (3200 centavos), `"lemonade"` (1000 centavos)

## 4. Mapeamento de Telas do Front-end para Endpoints

### 4.1 Entrada na Mesa (`entrada` -> `conectando` -> `inicio`)
- **Endpoint**: `POST /api/joinTable`
- **Body**: `{ "restaurantId": "restaurante-demo", "tableId": "mesa-13", "displayName": "Luciano" }`
- **Resposta (`200`)**: `{ "result": { "sessionId": "sessao-mesa-13-ativa", "participantId": "<uid-do-cliente>" } }`

### 4.2 Quem está na Mesa (`inicio`, `dividir`, `mesa`)
- **Endpoint**: `POST /api/listSessionParticipants`
- **Body**: `{ "restaurantId": "restaurante-demo", "sessionId": "sessao-mesa-13-ativa" }`
- **Resposta (`200`)**: `{ "result": { "participants": [{ "participantId": "uid-1", "displayName": "Luciano" }] } }`

### 4.3 Listar Cardápio (`cardapio`)
- **Endpoint**: `POST /api/listMenu`
- **Body**: `{ "restaurantId": "restaurante-demo", "sessionId": "sessao-mesa-13-ativa" }`
- **Resposta (`200`)**: `{ "result": { "items": [{ "id": "fries", "name": "Fritas da casa", "description": "Crocantes, com aioli de ervas.", "priceCents": 3600, "sector": "kitchen" }] } }`

### 4.4 Criar Pedido Individual ou Dividido (`revisar-divisao` / `revisar-pedido`)
- **Endpoint**: `POST /api/createOrder`
- **Body**: `{ "restaurantId": "restaurante-demo", "sessionId": "sessao-mesa-13-ativa", "requestId": "req-01", "items": [{ "menuItemId": "burger", "quantity": 1, "notes": "Sem cebola" }, { "menuItemId": "fries", "quantity": 1, "inviteeIds": ["uid-karla", "uid-gabriel"] }] }`
- **Resposta (`200`)**: `{ "result": { "orderId": "<id-do-pedido>" } }`

### 4.5 Consultar e Responder Convites de Divisão (`aguardando`, `convite`)
- **Listar convites pendentes**: `POST /api/listInvitations` com `{ "restaurantId", "sessionId" }`
- **Consultar detalhes de uma parcela**: `POST /api/getShare` com `{ "restaurantId", "sessionId", "orderId", "itemId" }`
- **Aceitar ou recusar divisão**: `POST /api/respondToShare` com `{ "restaurantId", "sessionId", "orderId", "itemId", "accept": true }`

### 4.6 Resolver Divisão Recusada (`divisao-recusada`, `divisao-cancelada`)
- **Endpoint**: `POST /api/resolveRejectedSplit`
- **Body**: `{ "restaurantId": "restaurante-demo", "sessionId": "sessao-mesa-13-ativa", "orderId": "<orderId>", "itemId": "<itemId>", "requestId": "req-resolucao-01", "action": "cancel", "inviteeIds": [] }`
- **Ações aceitas**: `"cancel"`, `"assume"` ou `"reinvite"`.

### 4.7 Acompanhar Estado do Pedido (`pedido-enviado`, `acompanhar`, `pronto`, `entregue`)
- **Listar IDs dos pedidos do cliente**: `POST /api/listMyOrders` com `{ "restaurantId", "sessionId" }`
- **Listar itens e estados de um pedido**: `POST /api/listMyOrderItems` com `{ "restaurantId", "sessionId", "orderId" }`

### 4.8 Prévia da Comanda e Taxa de Serviço (`comanda`, `pagamento`)
- **Endpoint**: `POST /api/quoteCheckout`
- **Body**: `{ "restaurantId": "restaurante-demo", "sessionId": "sessao-mesa-13-ativa", "includeService": true }`
- **Resposta (`200`)**: `{ "result": { "consumptionCents": 5400, "serviceCents": 540, "totalCents": 5940 } }`

### 4.9 Chamar Atendimento na Mesa (`ajuda` -> `atendimento`)
- **Endpoint**: `POST /api/requestAssistance`
- **Body**: `{ "restaurantId": "restaurante-demo", "sessionId": "sessao-mesa-13-ativa", "requestId": "req-ajuda-01", "reason": "Ajuda com meu pedido" }`
- **Resposta (`200`)**: `{ "result": { "assistanceId": "<id-do-chamado>", "status": "received", "tableId": "mesa-13" } }`