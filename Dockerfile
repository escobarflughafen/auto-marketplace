FROM node:25-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci \
  && npx playwright install --with-deps chromium

COPY . .

EXPOSE 21435

CMD ["npm", "run", "marketplace:home:serve", "--", "--host", "0.0.0.0", "--port", "21435"]
