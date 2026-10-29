const express = require('express');
const corsMiddleware = require('./middlewares/cors.middleware');
const { globalErrorMiddleware } = require('./middlewares/error.middleware');
const apiRoutes = require('./routes/api.routes');

const app = express();

app.disable('x-powered-by');
app.use(corsMiddleware);
app.use(express.json({ limit: '32kb' }));
app.use(apiRoutes);
app.use(globalErrorMiddleware);

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => console.log(`API pronta na porta ${port}`));
}

module.exports = app;