# API no Render para prototipação

O Render será usado somente no protótipo. Antes de operação em restaurante, escolher outra hospedagem. O Firebase Authentication e Firestore continuam responsáveis pela identidade e pelos dados. A API utiliza as regras de negócio do backend; cada chamada protegida verifica o token Firebase e aplica as permissões no servidor. As regras do Firestore não restringem o Admin SDK, então as verificações da API continuam necessárias.

## Configuração de um Web Service no Render

Após enviar esta versão ao GitHub e confirmar os testes, criar um Web Service no projeto Render e conectar o repositório/branch desejado. Escolher Node, plano gratuito, diretório raiz do repositório, build `npm ci --prefix functions`, start `npm start --prefix functions` e health check `/health`. Configurar `FIREBASE_PROJECT_ID=vamo-rachar-e322f` e `FIREBASE_SERVICE_ACCOUNT_JSON` como variável secreta no Render. O servidor usa `PORT` automaticamente.

Para a credencial, criar uma conta de serviço dedicada no Google Cloud, concedendo apenas o acesso necessário ao Firestore e à verificação de usuários do Firebase Authentication; testar os papéis efetivos (por exemplo, Cloud Datastore User e Firebase Authentication Viewer) no projeto de teste. A chave JSON é sensível: cadastrar o conteúdo pelo campo secreto do Render, sem enviar em chat, repositório ou logs. Preferir um projeto de teste isolado. Revogar a chave se exposta. A configuração e as permissões reais dependem de acesso administrativo e ainda não foram verificadas neste ambiente.

A API oferece `GET /health` e `POST /api/<nomeDaOperação>`. Nas chamadas protegidas, enviar o token de ID do Firebase em `Authorization: Bearer <token>` e o objeto de entrada como JSON no corpo. A resposta bem-sucedida contém `{ "result": ... }`. Exemplo de operação: `POST /api/joinTable` com `{ "restaurantId": "...", "tableId": "...", "displayName": "Ana" }`. Não confiar em IDs ou permissões fornecidos pelo cliente; a identidade é obtida do token verificado. As operações e estados são descritos no README.

`/health` apenas indica que o servidor iniciou, não que Firebase está acessível. A verificação real deve autenticar um usuário e realizar operações de teste, com dados criados de forma controlada. O servidor não configura CORS para navegador nesta etapa.

## Limites e pendências

O plano gratuito do Render pode entrar em repouso e possui limites sujeitos às condições do provedor. Pagamentos, comprovantes, saída e fechamento simulados ainda funcionam apenas nos emuladores e não são expostos na API HTTP. Não há upload de comprovante real nem integração de pagamento. As regras e índices do Firestore precisam ser publicados separadamente após revisão; não há implantação automática neste repositório. Cadastro administrativo de restaurante, equipe, mesa e cardápio ainda precisa de um fluxo seguro. A entrada por QR ainda precisa de proteção antes do piloto.
