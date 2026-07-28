FROM node:24-alpine

WORKDIR /app
COPY server.js sources.js ./
COPY src ./src
COPY public ./public
COPY data ./data

ENV HOST=0.0.0.0
ENV PORT=4173
EXPOSE 4173

CMD ["node", "server.js"]
