# Usa uma imagem base do Python leve
FROM python:3.10-slim

# Define o diretório de trabalho no container
WORKDIR /app

# Copia todos os arquivos da pasta trilha para dentro do container
COPY . .

# Instala as dependências (se você tiver um requirements.txt)
# RUN pip install -r requirements.txt

# Entra na pasta aplicativo onde está o servidor.py
WORKDIR /app/aplicativo

# Comando para iniciar o servidor
CMD ["python", "servidor.py", "--host", "0.0.0.0", "--port", "8766"]