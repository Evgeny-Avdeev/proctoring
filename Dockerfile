FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /data
WORKDIR /app
COPY docs ./docs
COPY server ./server
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
USER node
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server/index.mjs"]
