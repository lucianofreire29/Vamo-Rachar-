# Decisões e pendências do Vamo Rachar

## Proteção de entrada por QR — importante, resolver antes do piloto

O fluxo desejado é entrada automática pelo QR da mesa e nome, sem aprovação da equipe. Um QR estático pode ser fotografado e compartilhado, permitindo entrada à distância. Avaliar e implementar uma proteção adequada antes do uso real: por exemplo, QR dinâmico, seus custos e limitações. Mesmo um QR temporário pode ser compartilhado enquanto válido. A solução e a experiência final ainda não foram decididas; o backend atual não valida presença física.

## Pagamento

O cliente enviará comprovante e a equipe conferirá o recebimento no canal financeiro do restaurante antes de autorizar a baixa. O comprovante por si só não confirma pagamento. Upload, revisão, baixa e saída ainda precisam ser implementados; fornecedor e integração real permanecem pendentes.

## Hospedagem durante o protótipo

Usar Render gratuito para a API e Firebase gratuito para Authentication e Firestore na prototipação. A hospedagem para uso em restaurantes será escolhida futuramente; o Render não é a solução planejada para essa operação. Avaliar Supabase posteriormente.
