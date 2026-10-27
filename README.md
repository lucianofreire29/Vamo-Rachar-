# Vamo Rachar!

Base inicial do backend em JavaScript com Firebase Cloud Functions, Authentication e Firestore. Nesta etapa há apenas um endpoint de saúde e regras iniciais de leitura restrita de identidade no Firestore; os fluxos de negócio e permissões serão implementados depois.

## Requisitos

Node.js 22, npm e Java 21. Os emuladores são baixados pelo Firebase CLI no primeiro uso, com acesso a `storage.googleapis.com`. O projeto `demo-vamo-rachar` é exclusivamente local e não exige credenciais nem cria recursos reais.

## Instalação e execução

Na raiz do repositório:

```sh
npm ci
npm ci --prefix functions
npm run check
npm run emulators
```

Os emuladores usam as portas 5001 (Functions), 9099 (Auth) e 8080 (Firestore). A função `health` responde a GET em `/demo-vamo-rachar/us-central1/health` no emulador de Functions.

Para verificar o código e executar a verificação automatizada dos três emuladores:

```sh
npm run check
npm run test:emulators
```

Os testes verificam a resposta de saúde, a autenticação anônima e as regras de isolamento no Firestore. Cada participante pode consultar apenas seu próprio registro; funcionários podem consultar apenas o próprio vínculo com cada restaurante. Todas as escritas diretas e demais leituras são negadas nesta etapa. Os registros de teste são criados com privilégios administrativos no emulador; a API de ingresso e o cadastro de equipe ainda serão implementados. Ele não verifica os fluxos de negócio, ainda não implementados. O GitHub Actions executa esses comandos em pushes e pull requests.

Em ambientes com diretório pessoal sem permissão de escrita, configure `npm_config_cache`, `XDG_CONFIG_HOME` e `FIREBASE_EMULATORS_PATH` para diretórios graváveis antes de instalar ou executar os emuladores.

O projeto Firebase informado é `vamo-rachar-e322f`, registrado no alias `cloud`. O alias padrão e os comandos de emulador continuam usando o projeto demo. Antes de qualquer implantação, configure a autenticação e as permissões necessárias e escolha explicitamente o projeto de destino. A criação do alias não ativa serviços nem publica código.

## Abrir uma sessão de mesa

A função chamável `openTableSession` recebe `{ restaurantId, tableId, requestId }` e requer usuário autenticado com registro `restaurants/{restaurantId}/staff/{uid}` ativo e papel `waiter` ou `manager`. A mesa deve existir em `restaurants/{restaurantId}/tables/{tableId}` e não ter `activeSessionId`. A operação cria uma sessão, associa-a à mesa e registra um evento em uma transação. A repetição do mesmo `requestId` pelo mesmo usuário e restaurante devolve a mesma sessão; use um ID novo para cada operação diferente. O `status: open` retornado representa o resultado da abertura, não uma consulta atualizada da sessão.

Os testes criam mesa e funcionário apenas no emulador. Cadastro seguro da equipe, criação de mesas, ingresso de clientes e encerramento ainda não foram implementados. As regras e funções locais não foram publicadas no Firebase real.

## Entrada na mesa e pagamento: decisões de produto

A entrada prevista é pelo QR da mesa e nome, sem aprovação da equipe. `joinTable` recebe `{ restaurantId, tableId, displayName }` com autenticação Firebase (inclusive anônima), localiza a sessão ativa e cria um participante por identidade nessa sessão; repetição retorna o mesmo registro. A geração e leitura do QR e a recuperação de identidade ainda não estão implementadas. Um QR estático pode ser fotografado ou compartilhado, permitindo entrada remota; não comprova presença física.

O cliente deverá enviar comprovante para análise da equipe. O envio não confirma pagamento: a equipe precisa verificar o recebimento no canal financeiro do restaurante antes de autorizar a baixa. Upload, análise, baixa, saída da mesa e tratamento de comprovantes ainda não foram implementados.

**Pendência importante antes do piloto:** proteger a entrada por QR contra uso à distância. A solução ainda será escolhida; veja [decisões e pendências](docs/decisoes-e-pendencias.md).

## Cardápio inicial

A função chamável `listMenu` recebe `{ restaurantId, sessionId }`, exige um participante ativo da sessão aberta e retorna produtos disponíveis com valores em centavos e setor. Neste protótipo retorna no máximo 100 itens, sem paginação; paginação e cadastro administrativo do cardápio ainda são necessários. Os valores não substituem a validação de preço no servidor ao criar pedidos, que ainda será implementada.

## Pedidos

`createOrder` é uma função chamável autenticada. Recebe `{ restaurantId, sessionId, requestId, items: [{ menuItemId, quantity, notes? }] }` e retorna `{ orderId }`. O participante deve estar ativo na sessão aberta; cada chamada aceita de 1 a 20 itens, quantidade de 1 a 99 e observação opcional de até 500 caracteres. O servidor consulta produtos disponíveis, congela nome, preço e setor e cria uma parcela integral para o participante. Setores aceitos atualmente são `bar` e `kitchen`. Repetir o mesmo `requestId` com os mesmos itens retorna o mesmo pedido; reutilizá-lo com conteúdo diferente gera erro.

A operação também aceita `inviteeIds` em cada item. A divisão é em centavos, com centavos restantes distribuídos pela ordem dos IDs. O iniciador aceita automaticamente; o item aguarda todos os convidados antes de passar a `received`. `getShare` permite a um participante consultar sua parcela e o valor total, e `respondToShare` registra seu aceite ou recusa. Ambas recebem `restaurantId`, `sessionId`, `orderId` e `itemId`; a resposta também recebe `accept` booleano. `listInvitations` recebe `restaurantId` e `sessionId` e lista até 100 convites pendentes do próprio participante, sem paginação. Uma recusa cancela os demais convites pendentes; o iniciador pode usar `resolveRejectedSplit` com `action` igual a `cancel`, `assume` ou `reinvite` e um `requestId` único. Para `reinvite`, informe `inviteeIds`. O item original é cancelado e mantido no histórico; quando necessário, um novo item vinculado preserva o preço original. O pagamento ainda não está implementado. O teste automatizado usa dados fictícios no emulador; não há publicação no Firebase real.

Cada pedido aceita até 19 convidados por item e 150 convites no total. A expiração de convites ainda não foi implementada.

## Operação de preparo e entrega

`listWorkQueue` recebe `restaurantId` e `sector` (`bar` ou `kitchen`); exige funcionário ativo com papel correspondente e retorna até 100 itens ativos. `listReadyItems` exige papel `waiter` e retorna até 100 itens prontos ou retirados. As listagens ainda não têm paginação nem notificações em tempo real. `transitionItem` recebe `restaurantId`, `itemId` e `action`: `start`, `ready`, `pickup` ou `deliver`. Bar/cozinha iniciam e marcam pronto somente no próprio setor; garçom retira e entrega. Transições inválidas são recusadas e eventos são registrados. Itens compartilhados só entram na fila após todos os aceites. O índice definido em `firestore.indexes.json` precisará ser implantado quando houver publicação autorizada.

`markItemUnavailable` recebe `restaurantId`, `itemId` e `reason` (obrigatório, até 500 caracteres). Um funcionário ativo do setor pode sinalizar indisponibilidade enquanto o item estiver recebido ou em preparo. O motivo e o autor são registrados no histórico e o item sai da fila ativa. A consulta do estado está disponível pela API; a correção da comanda ainda não foi implementada; não se deve utilizar o estado atual para cobrança real.

`listMyOrderItems` recebe `restaurantId`, `sessionId` e `orderId` e retorna apenas itens com parcela do participante, incluindo estado e motivo de indisponibilidade. A consulta ainda exige conhecer o ID do pedido, não envia notificações e retorna erro se houver mais de 100 itens históricos no pedido; paginação ainda precisa ser implementada.

`listMyOrders` recebe `restaurantId` e `sessionId` e lista IDs dos pedidos associados ao participante, inclusive convites. A consulta exige sessão aberta e participante ativo e retorna erro acima de 100 pedidos, até que exista paginação.

## Prévia da comanda

`quoteCheckout` recebe `restaurantId`, `sessionId` e `includeService` (booleano). Retorna consumo, serviço e total em centavos, somando apenas parcelas aceitas de itens confirmados; exclui divisões pendentes ou recusadas, itens cancelados e indisponíveis. Para o protótipo, os 10% são arredondados ao centavo mais próximo, com meio centavo arredondado para cima; a política definitiva depende do piloto. A consulta tem limites de 100 pedidos e 100 itens históricos por pedido.

Esta é uma prévia, não um saldo final: as leituras usam uma transação somente de leitura, mas não há pagamentos, ajustes ou estornos e os dados podem mudar depois da consulta. O fechamento futuro deverá recalcular e validar o valor atomicamente e verificar pendências antes de criar qualquer pagamento. Não utilizar para cobrança real.

## Pagamento simulado somente no emulador

`startSandboxCheckout` recebe `restaurantId`, `sessionId`, `requestId` e `includeService`, calcula a comanda em transação e bloqueia novos pedidos do participante durante a tentativa. Exige entrega dos itens e resolução das divisões pendentes. `submitSandboxProof` recebe `restaurantId`, `sessionId` e `paymentId` e simula o envio; não recebe nem armazena arquivo. `reviewSandboxPayment` recebe os mesmos IDs e `approve` booleano; garçom ou gestor pode confirmar ou recusar. Recusa reabre a comanda; confirmação marca o participante como pago apenas nos dados simulados. As três funções recusam execução fora do emulador.

Não existe upload real, integração financeira, verificação bancária, estorno, reconciliação ou fechamento da mesa. Antes de qualquer operação real, definir e testar armazenamento privado dos comprovantes, controle de acesso e retenção, verificação de recebimento, exceções e integração contratada pelo restaurante. A simulação não comprova pagamento real.

`closeSandboxTableSession` permite que garçom ou gestor encerre uma sessão simulada quando participantes estão pagos, pagamentos resolvidos e itens entregues, cancelados ou indisponíveis. Libera a mesa para uma nova sessão e é idempotente. Limitado ao emulador e a 100 participantes, pagamentos e pedidos e 100 itens por pedido. Existe saída simulada sem consumo, mas ainda não há tratamento completo de exceções financeiras; esses casos devem ser resolvidos antes do piloto.

`leaveSandboxWithoutConsumption` recebe `restaurantId` e `sessionId` e permite que o participante saia quando todos os seus itens estão cancelados ou indisponíveis, ou quando não há itens. Divisões pendentes e consumo bloqueiam a saída. Limitada ao emulador; a regra para reingresso ainda precisa ser definida.

`listSandboxPaymentsForReview` recebe `restaurantId` e `sessionId` e lista comprovantes simulados pendentes para garçom ou gestor, com limite de 100 sem paginação. `getSandboxPayment` recebe também `paymentId` e permite ao titular consultar o estado da tentativa. Ambas as operações são restritas ao emulador e não fornecem arquivos de comprovantes.

`listSessionParticipants` recebe `restaurantId` e `sessionId` e lista os participantes ativos da mesma sessão para escolha de convidados, retornando somente identificador e nome de exibição. A consulta exige participante ativo, não inclui quem já saiu ou pagou e retorna erro acima de 100 participantes até que haja paginação.

## API HTTP no Render para protótipo

A API Node.js pode ser iniciada com `npm start --prefix functions`. Ela verifica tokens do Firebase e reutiliza as operações existentes. As instruções de configuração, credenciais e limitações estão em [Render para prototipação](docs/render-prototipo.md). Os pagamentos e o fechamento simulados continuam disponíveis apenas no emulador.
