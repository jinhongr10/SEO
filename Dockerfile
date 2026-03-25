FROM node:20-alpine AS build
WORKDIR /app

# Install deps first for better cache
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy source and build
COPY . .
ARG GEMINI_API_KEY=
ENV GEMINI_API_KEY=$GEMINI_API_KEY
RUN npm run build

FROM nginx:1.27-alpine AS runner
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
