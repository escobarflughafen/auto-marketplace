FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci \
  && npx playwright install --with-deps chromium

COPY . .

EXPOSE 21435

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:21435/api/summary').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "marketplace:home:serve", "--", "--host", "0.0.0.0", "--port", "21435"]
