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

## Dados Fictícios e Identidade (Seed do Protótipo)

O script `scripts/seed-prototipo.cjs` prepara o ambiente de forma idempotente (sem sobrescrever sessões ativas ou apagar dados de terceiros):

- **Restaurante (`restaurants/restaurante-demo`)**: `{ name: string, active: boolean }`.
- **Identidade da Equipe (`staff/staff-gerente-demo`)**: Conta persistente no Firebase Auth (`equipe@vamorachar.demo`), separada da autenticação anônima dos clientes. Vínculo administrativo com `{ active: boolean, roles: string[] }`.
- **Cardápio (`menuItems/{id}`)**: `{ name: string, description: string, priceCents: number (int), sector: 'kitchen' | 'bar', available: boolean }`. Inclui `fries` (3600), `burger` (3200) e `lemonade` (1000).
- **Mesas e Sessão (`tables/mesa-13`)**: Cria `mesa-01` a `mesa-20` e garante uma sessão aberta (`sessao-mesa-13-ativa`) vinculada em `activeSessionId`.