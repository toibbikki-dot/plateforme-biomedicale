# rebuild-2026-07-05
FROM python:3.11-slim

WORKDIR /app

COPY ia/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY ia/ .

EXPOSE 5001

CMD ["python", "serveur_ia.py"]
