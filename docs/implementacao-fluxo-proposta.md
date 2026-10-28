# Implementação experimental do fluxo por código

Trabalho na branch `proposta-fluxo-equipe`; não está aprovado nem publicado na `main` ou no Render. A proposta funcional está em [fluxo-equipe-codigo.md](fluxo-equipe-codigo.md). A área de administração e as demais telas ainda não foram implementadas.

## Decisões aplicadas no backend

- O administrador usa Firebase Authentication com segundo fator, e precisa ter documento ativo em `restaurants/{restaurantId}/admins/{uid}`. A API verifica o token Firebase e a presença do segundo fator autenticado; nenhum funcionário comum ganha acesso administrativo por ter seu código.
- Um gerente ativa a tela compartilhada com seu código. No protótipo, o vínculo fica associado à identidade Firebase técnica do dispositivo, à tela `plaza`, `bar` ou `kitchen`, e expira em 12 horas. O administrador pode desativar o dispositivo. **A duração de 12 horas é uma configuração inicial para avaliação, não uma regra de produto definitiva.**
- A praça ativa exige o código de garçom ou gerente para abrir a mesa e cancelar um item. Após início de preparo, inclusive após entrega, só o gerente pode cancelar. Para evitar perda de informação financeira, o cancelamento é bloqueado se um participante estiver com pagamento pendente ou quitado; tratamento de ajustes/estornos permanece pendente.
- Produtos podem ter `sectors: ["bar"]`, `["kitchen"]` ou `["bar", "kitchen"]`. Os dados antigos com `sector` continuam aceitos. Cada destino tem seu próprio andamento; a mesma parcela é cobrada uma vez. Se somente parte de um item estiver indisponível, a comanda é bloqueada para revisão, até que exista uma regra de resolução aprovada.
- O seed de protótipo só roda nos emuladores e em projeto `demo-*`. Cria apenas dados ausentes; não cria contas, senhas nem sessões, e não altera documentos existentes. A versão da `main` anterior a essa mudança contém uma senha padrão; se foi usada, a conta precisa ter a senha trocada ou ser desativada.

## Contratos HTTP iniciais

As operações são `POST /api/<nome>` com token Firebase válido. O usuário cliente pode usar autenticação anônima. Para o administrador, o token precisa conter um segundo fator confirmado e o UID precisa estar cadastrado como administrador ativo no estabelecimento. A criação inicial desse administrador, o login com segundo fator e a recuperação de acesso ainda não foram implementados.

- `saveAdminProduct`: `{ restaurantId, productId, name, description?, priceCents, sectors, available, photoUrl? }`. Cria ou atualiza produto; a foto é uma URL HTTPS, não há upload de arquivo. `listAdminProducts` recebe `{ restaurantId }` e inclui produtos indisponíveis.
- `createEmployeeCode`: `{ restaurantId, employeeId, displayName, role }`, com `role` igual a `waiter` ou `manager`. Retorna um código gerado de 8 dígitos **uma única vez**. `rotateEmployeeCode` troca um código ativo e invalida o anterior. `disableEmployeeCode` desativa o funcionário; `listAdminEmployees` não devolve código nem resumo criptográfico. Se a resposta com o código se perder, será necessário rotacionar o código.
- `activateSharedDevice`: `{ restaurantId, screen, code }`, chamado com a identidade Firebase técnica do dispositivo. `screen` é `plaza`, `bar` ou `kitchen`; exige código de gerente. `listAdminDevices` e `disableSharedDevice` são administrativos.
- `openTableWithCode`: `{ restaurantId, tableId, requestId, code }`. Exige tela da praça ativada e código ativo de garçom/gerente. Repetir o mesmo `requestId` no mesmo dispositivo para a mesma mesa e funcionário devolve a sessão inicial.
- `cancelItemWithCode`: `{ restaurantId, sessionId, orderId, itemId, code, reason }`. Exige praça ativa; ao iniciar preparo, apenas gerente. Cancela o item, retira filas, mantém histórico e encerra convites pendentes. Não executa estorno.
- `listWorkQueue`, `transitionItem`, `markItemUnavailable` e `listReadyItems` usam o dispositivo ativado da tela correspondente. Para um item com dois setores, `transitionItem` e `markItemUnavailable` recebem também `sector`. Para itens legados de um setor, o campo é opcional.

A rota HTTP antiga `openTableSession`, que dependia de login individual da equipe, foi retirada do adaptador do Render. Ela permanece apenas nos testes de compatibilidade do emulador; não usar para telas compartilhadas. As demais operações legadas de funcionário também aceitam os dispositivos ativados; o fallback de login individual existe apenas no emulador para os testes antigos.

## Segredos e proteção dos códigos

`STAFF_CODE_PEPPER` deve ser um segredo aleatório criptograficamente forte, com pelo menos 32 caracteres, configurado no servidor, nunca no Git ou no cliente. Sem ele, a API recusa gerar/validar códigos. Os códigos não são armazenados em texto puro: a busca utiliza HMAC com o segredo. A troca desse segredo invalida os códigos existentes e requer um plano de rotação; não alterar sem planejar. Os dados de teste usam um segredo fictício apenas no processo de teste.

Há um limite inicial compartilhado por restaurante de 10 códigos incorretos a cada 5 minutos. Esse mecanismo reduz tentativas, mas pode bloquear temporariamente toda a equipe; precisa ser refinado e avaliado antes de operação real. Os códigos não devem ser incluídos em logs nem enviados em URLs. A resposta de criação/rotação é sensível e deve ser exibida de modo seguro, apenas uma vez.

## Validação e pendências antes de aprovar

- Testes locais cobrem o seed, roteamento duplo, cobrança única, indisponibilidade parcial, permissões, ativação de dispositivo, abertura com código, cancelamento antes e depois de preparo/entrega, rotação e bloqueio por tentativas.
- Os testes administrativos usam uma alegação de segundo fator simulada diretamente nos handlers. **Não validam uma sessão MFA real do Firebase.** Verificar com documentação oficial do Firebase a disponibilidade do método de segundo fator escolhido no plano gratuito e os eventuais requisitos/custos. O acesso à documentação externa estava bloqueado neste ambiente.
- Criar e testar o fluxo de autenticação administrativa real, provisionamento inicial, recuperação, telas e vínculo seguro do dispositivo. Verificar limites e revogação na prática.
- Definir a resolução de indisponibilidade parcial, cancelamento/ajuste após pagamento e notificações aos setores e cliente. Não realizar cobrança real.
- Adicionar paginação às listagens administrativas, que falham acima de 100 registros; `listMenu` e filas existentes também têm limites documentados.
- A migração de produto e fila em dados já existentes precisa ser planejada e testada antes de publicar. Nenhum dado do Firebase real foi alterado por esta branch.
- O cancelamento, produto de dois setores e limites precisam de revisão de concorrência, segurança, contrato e testes ponta a ponta com o front-end. Não há deploy automático ou envio para `main` nesta etapa.
