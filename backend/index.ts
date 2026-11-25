import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import 'dotenv/config';
import checkVersion from './middlewares/version.js';
import healthRoutes from './v1/modules/health/routes.js';


const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());

app.use('/health', healthRoutes);

app.use(checkVersion());

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  const status = typeof err?.status === 'number' ? err.status : 500;
  const message = err?.expose ? err.message : 'Internal server error';
  res.status(status).json({ status: 'error', data: null, message });
};
app.use(errorHandler);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`App live on port ${port}`);
});
