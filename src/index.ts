import { app } from './app';
import dotenv from 'dotenv';
import logger from './utils/logger';

dotenv.config();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
}); 