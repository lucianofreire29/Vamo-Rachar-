# Arquitetura do Back-end (Vamo-Rachar)

Para preparar a integração com o repositório de Front-end e facilitar a manutenção, o código em `functions/src/` foi modularizado em camadas de responsabilidade única:

## Estrutura de Diretórios (`functions/src/`)

- **`config/`**: Inicialização do Firebase Admin SDK, Firestore e variáveis de ambiente.

- **`middlewares/`**: Interceptadores HTTP responsáveis por segurança de conexão entre 

repositórios (`cors.middleware.js`), validação de sessão/autenticação (`auth.middleware.js`) e tratamento padronizado de erros (`error.middleware.js`).

- **`routes/`**: Definição dos endpoints da API (`session.routes.js` e `bill.routes.js`), atuando como ponto de entrada das requisições vindas do front-end.

- **`controllers/`**: Camada responsável por receber as requisições HTTP (`req`), acionar os serviços correspondentes e retornar as respostas padronizadas (`res`) com os devidos códigos de status HTTP.

- **`services/`**: Camada de regras de negócio e persistência no Firestore. Concentra a lógica de criação de sessões e os cálculos matemáticos de rateio de despesas, taxas de serviço e divisão por participante.

- **`utils/`**: Funções utilitárias e validadores de entrada de dados (`validators.js`).

- **`index.js` e `server.js`**: Ponto de exportação para o Firebase Cloud Functions e inicialização do servidor HTTP.