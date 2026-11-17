FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/* && npm install -g pm2@6.0.14
USER node
WORKDIR /home/node
