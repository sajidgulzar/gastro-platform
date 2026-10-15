FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data TRUST_PROXY=1 COOKIE_SECURE=1
VOLUME /data
EXPOSE 3000
CMD ["node","--no-warnings","server.js"]
