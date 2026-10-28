# Arquitetura do Back-end (Vamo-Rachar)

Para preparar a integração com o front-end, foram criadas pastas para uma futura separação em camadas. A maior parte da lógica ainda está em `index.js` e `server.js`; os módulos indicados abaixo, exceto CORS, são estruturas a implementar:

## Estrutura de Diretórios (`functions/src/`)

- **`config/`**: Inicialização do Firebase Admin SDK, Firestore e variáveis de ambiente.

- **`middlewares/`**: Interceptadores HTTP responsáveis por segurança de conexão entre 

repositórios (`cors.middleware.js`), validação de sessão/autenticação (`auth.middleware.js`) e tratamento padronizado de erros (`error.middleware.js`).

- **`routes/`**: Definição dos endpoints da API (`session.routes.js` e `bill.routes.js`), atuando como ponto de entrada das requisições vindas do front-end.

- **`controllers/`**: Camada responsável por receber as requisições HTTP (`req`), acionar os serviços correspondentes e retornar as respostas padronizadas (`res`) com os devidos códigos de status HTTP.

- **`services/`**: Camada de regras de negócio e persistência no Firestore. Concentra a lógica de criação de sessões e os cálculos matemáticos de rateio de despesas, taxas de serviço e divisão por participante.

- **`utils/`**: Funções utilitárias e validadores de entrada de dados (`validators.js`).

- **`index.js` e `server.js`**: Ponto de exportação para o Firebase Cloud Functions e inicialização do servidor HTTP.

## Dados fictícios no emulador

O script `scripts/seed-prototipo.cjs` cria apenas documentos ausentes de restaurante, cardápio e mesas em projeto `demo-*` com os emuladores de Authentication e Firestore ativos. Não cria conta, senha, funcionário ou sessão; documentos existentes são preservados. A equipe e abertura de mesa com códigos individuais estão pendentes de implementação. O script não aceita execução no Firebase real.

Execução: `firebase emulators:exec --project demo-vamo-rachar --only auth,firestore "node scripts/seed-prototipo.cjs"` usando o Firebase CLI instalado no projeto. Não executa limpeza de dados.
