# Backend — estado atual e trabalho restante

Referência: 27/10/2026. Escopo atual: prototipação, sem operação em restaurante ou cobrança real.

## 1. Decisões que orientam o trabalho

- JavaScript no servidor; API Node.js/Express no Render gratuito durante o protótipo.
- Firebase Authentication e Firestore no plano gratuito. Não depender de publicação de Cloud Functions nem de Blaze.
- A hospedagem para uso em restaurante será escolhida futuramente. Supabase é uma possibilidade futura, não uma migração em andamento.
- Backend primeiro; Luciano fará os protótipos das telas no Figma. Front-end não faz parte desta etapa.
- Entrada desejada: QR da mesa e nome, sem autorização da equipe. Proteção contra entrada à distância foi adiada, mas continua importante antes do piloto.
- No fluxo de pagamento desejado, o cliente envia comprovante e a equipe confirma o recebimento antes da baixa. Um comprovante isolado não comprova crédito na conta do restaurante.

## 2. O que já existe e o que foi verificado

| Área | Implementação atual | Evidência e limite |
|---|---|---|
| API HTTP | Express, token Firebase obrigatório nas operações, validação de identidade no servidor | Testes com emuladores; usuário informou deploy no Render e executou teste de conexão com sucesso |
| Conexão publicada | API em `https://vamo-rachar.onrender.com`, projeto `vamo-rachar-e322f` | Usuário confirmou `/health`, login anônimo e recusa esperada ao consultar sessão inexistente; pedidos completos na nuvem ainda não foram testados |
| Sessões e participantes | Abrir mesa, entrar, listar participantes ativos | Fluxos testados nos emuladores; cadastro administrativo ainda é manual |
| Cardápio e pedidos | Consultar disponíveis, criar pedido com preço/setor do servidor e evitar duplicatas | Testados nos emuladores; falta cadastro administrativo e teste funcional publicado |
| Divisão | Parcelas em centavos, convite, consulta, aceite/recusa e resolução pelo iniciador | Testados nos emuladores; sem expiração de convite |
| Operação | Filas por setor, preparo, pronto, retirada, entrega, indisponibilidade com motivo | Testadas nos emuladores; sem notificações/listeners |
| Comanda | Prévia individual consistente, serviço opcional de 10%, exclusão de cancelados/indisponíveis | Testada nos emuladores; não é um extrato financeiro completo |
| Pagamento e encerramento | Simulação de tentativa, comprovante, análise da equipe, saída sem consumo e encerramento | Apenas emuladores; o fluxo completo de duas pessoas passou, inclusive recusa e nova tentativa |
| Regras do Firestore | Leitura restrita do próprio registro; escrita direta bloqueada | Testadas nos emuladores; publicação das regras e índices no projeto real não foi confirmada |
| GitHub Actions | Verificação de JavaScript e testes com Auth, Firestore, Functions e API HTTP | Aprovação das versões enviadas confirmada pelo usuário; monitoramento automático da API do GitHub segue indisponível neste ambiente |

A API no Render ainda reutiliza handlers de Cloud Functions via `.run`. Não exige hospedar Functions no Firebase, mas mantém essa dependência no código.

## 3. Prioridade 1 — preparar testes funcionais no Render

### 3.1 Dados fictícios e identidade da equipe

- [x] Criar restaurante, mesa e cardápio de teste com campos e tipos documentados (`scripts/seed-prototipo.cjs` e `docs/arquitetura-backend.md`).
- [x] Criar usuário autenticado de equipe e vínculo `staff` por procedimento administrativo confiável, sem permitir autoatribuição de papel.
- [x] Separar identidade anônima do cliente de conta persistente da equipe; definir login e recuperação para funcionários.
- [x] Criar procedimento repetível de preparação/limpeza dos dados de teste, sem sobrescrever documentos existentes nem apagar dados de terceiros.
- [ ] Verificar regras e índices efetivamente publicados no projeto, preservando configurações existentes até revisão.

**Conclusão:** abrir mesa, entrar como cliente, consultar cardápio, criar pedido e percorrer preparo/entrega pela API publicada, com IDs e contas fictícias, sem editar estados operacionais manualmente.

### 3.2 Teste pela rede

- [x] Preparar comandos ou coleção de cliente de API para as operações publicadas, com token em memória e sem logs de credenciais (`scripts/network-security-test.cjs`).
- [x] Testar falta de token, token inválido, papel errado e isolamento entre restaurantes na API publicada.
- [x] Verificar o comportamento após repouso do Render, expiração do token, perda de conexão e repetição de requisição.
- [x] Não interpretar `/health` como teste de acesso ao banco: ele verifica apenas o servidor.

## 4. Prioridade 2 — completar o protótipo funcional

### 4.1 Pagamento simulado na API HTTP

- [ ] Definir como oferecer simulação no ambiente de protótipo, com ativação explícita e isolamento de dados.
- [ ] Adaptar os sete endpoints de simulação hoje limitados ao emulador, sem remover a proteção indiscriminadamente.
- [ ] Revalidar cálculo e bloqueios em transação ao iniciar o fechamento.
- [ ] Testar análise autorizada, recusa, nova tentativa, confirmação idempotente e bloqueio de novos débitos durante/após fechamento.
- [ ] Publicar contratos e testar fechamento separado de duas pessoas no Render.

**Conclusão:** executar todo o ciclo fictício pela API HTTP, sem cobrança nem upload real. Atualmente isso só é possível nos emuladores.

### 4.2 Administração e operação assistida

- [ ] APIs de cadastro e atualização de restaurante, mesas e cardápio, incluindo preço, setor e disponibilidade.
- [ ] Provisionamento de gestores e gerenciamento de equipe/papéis, com auditoria e revogação de acesso.
- [ ] Listagem autorizada de mesas/sessões e visão operacional para o garçom.
- [ ] Pedido assistido por funcionário em nome do participante, com autorização e autoria registradas.
- [ ] Decidir permissões de gestor: hoje ele abre/encerra sessões simuladas e confere pagamentos simulados, mas não recebe automaticamente todas as permissões de bar, cozinha ou garçom.

### 4.3 Listagens e atualização das telas

- [ ] Paginação por cursor e ordenação previsível em cardápio, convites, pedidos, participantes, filas e análises de pagamento.
- [ ] Evitar truncamento silencioso: algumas consultas usam limite de 100 sem paginação; outras retornam erro acima desse limite.
- [ ] Definir atualização em tempo real ou consulta periódica, com custo de leitura controlado e escopo por papel/restaurante.
- [ ] Se forem usados listeners diretos do Firestore, projetar dados e regras específicos; as regras atuais não liberam leitura geral da sessão.
- [x] Configurar CORS para as origens das interfaces Web (`cors.middleware.js` configurado para ambiente local e variável `CORS_ORIGINS`).

## 5. Prioridade 3 — regras e exceções ainda incompletas

### Mesa e identidade

- [ ] Escolher proteção contra QR fotografado/compartilhado antes do piloto, preservando a entrada automática desejada.
- [ ] Definir formato público do QR e resolução de restaurante/mesa; geração do QR ainda não existe.
- [ ] Definir recuperação da participação ao trocar/perder aparelho: nova identidade anônima não recupera automaticamente a anterior.
- [ ] Definir reingresso, segunda comanda e reabertura depois de sair ou pagar. Hoje a mesma identidade não volta a ficar ativa automaticamente na mesma sessão.
- [ ] Definir transferência de mesa e atuação em sessão inconsistente.

### Pedidos e divisão

- [ ] Definir prazo de expiração de convite e implementar expiração auditável.
- [ ] Definir cancelamentos antes/depois de preparo, permissões e efeitos financeiros.
- [ ] Definir o tratamento de recusas/saídas pendentes e de alterações na proposta de divisão.
- [ ] Confirmar no piloto a política de centavos restantes; hoje a distribuição usa a ordem dos IDs dos participantes.
- [ ] Rever limites de itens/convidados e quantidade de operações por transação com testes de fronteira.
- [ ] Conferir comportamento de repetição e conflito em todas as mutações. Nem toda transição operacional possui repetição idempotente.

### Comandas e finanças

- [ ] Criar extrato auditável que separe consumo, serviço escolhido, pagamentos, ajustes e estornos.
- [ ] Derivar e reconciliar os totais da mesa sem duplicar itens compartilhados.
- [ ] Definir arredondamento/configuração da taxa de serviço e regras de repasse. O protótipo usa 10% com arredondamento ao centavo mais próximo, meio para cima.
- [ ] Definir pagamentos parciais, presenciais, expiração, reabertura e contestação conforme o fluxo escolhido.
- [ ] Garantir que correções posteriores não apaguem compromissos ou baixas anteriores.

## 6. Comprovante real — etapa posterior ao fluxo simulado

- [ ] Escolher armazenamento compatível com a decisão de não usar Blaze e verificar custos/limites; não presumir que Firebase Storage estará disponível gratuitamente.
- [ ] Implementar upload privado com limite de tamanho, formatos permitidos e validação do arquivo.
- [ ] Permitir consulta apenas ao titular e à equipe autorizada, sem URL pública permanente.
- [ ] Vincular cada arquivo à tentativa correta, impedindo reutilização indevida.
- [ ] Registrar autor, data, decisão e motivo da recusa na análise.
- [ ] Definir retenção e exclusão dos arquivos.
- [ ] Documentar conferência no banco/provedor antes da baixa; não reconhecer pagamento apenas pela imagem.

Não implementar cobrança real nem integração com PDV nesta fase. Escolha de fornecedores e validação contratual continuam pendentes.

## 7. Qualidade técnica e segurança a evoluir

- [x] Separar domínio, persistência Firebase e transportes HTTP (`config/`, `middlewares/`, `routes/`, `controllers/` e `services/`).
- [x] Centralizar esquemas de entrada, erros, estados e papéis (`utils/validators.js` e `middlewares/error.middleware.js`).
- [ ] Testar JSON com tipos inesperados, campos desconhecidos e limites de payload.
- [ ] Implementar limites de requisição e proteção contra criação abusiva de participantes/pedidos.
- [ ] Adicionar logs estruturados e identificação de requisição, sem tokens, chaves ou conteúdo de comprovantes.
- [ ] Distinguir indisponibilidade de serviços externos de erros de autenticação para facilitar diagnóstico.
- [ ] Confirmar privilégios mínimos da conta de serviço e procedimento de rotação/revogação da chave.
- [ ] Medir leituras, tempo e contenção das consultas/transações; otimizar projeções conforme dados de teste.
- [ ] Ampliar testes de concorrência, isolamento, falhas e limites, inclusive ausência de exposição dos endpoints simulados.
- [x] Criar contrato de API consolidado (por exemplo OpenAPI), exemplos e instruções de autenticação para as futuras telas.
- [ ] Definir publicação e rollback: branch de teste → Actions aprovado → main → deploy → teste autenticado na nuvem.

## 8. Depois da prototipação

Escolher hospedagem adequada para operação, restaurante piloto, PDV/versão, provedor de pagamento, privacidade/retenção, suporte e contingência. Validar custos e desempenho antes de prometer capacidade operacional. A eventual migração para Supabase deve ser planejada separadamente, incluindo identidade, dados, permissões e testes.

## 9. Ordem recomendada para retomar

1. Preparar dados/contas fictícias e verificar regras/índices no Firebase.
2. Testar pedidos individuais/divididos e preparo/entrega pela API no Render.
3. Completar a simulação de pagamento/saída/encerramento no ambiente HTTP de protótipo.
4. Criar APIs administrativas, paginação e contrato para as interfaces.
5. Completar exceções e reforços técnicos guiados pelos testes.
6. Implementar comprovantes reais somente após decidir armazenamento e acesso.

Esta lista é planejamento. Itens desmarcados não representam capacidades já entregues nem autorização para contratar serviços pagos.
