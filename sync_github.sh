#!/bin/bash

# Guarda a data e hora do momento em que o script iniciou
TIMESTAMP=$(date +'%Y-%m-%d %H:%M:%S')

# Função que realiza o processo do Git
sincronizar_repositorio() {
    local DIR=$1
    local NOME=$2

    echo "======================================"
    echo "Verificando repositório: $NOME"
    
    # Tenta entrar no diretório; se falhar, avisa e aborta apenas esta etapa
    if ! cd "$DIR"; then
        echo "❌ Erro: Não foi possível acessar $DIR"
        return
    fi

    # Verifica se existem alterações pendentes
    if [ -n "$(git status --porcelain)" ]; then
        git add .
        git commit -m "Atualização automática: $TIMESTAMP"
        # Se a branch for master, altere 'main' para 'master'
        git push origin main
        echo "✅ Backup enviado com sucesso."
    else
        echo "⏩ Nenhuma alteração pendente."
    fi
}

# 1. Sincroniza o diretório Trilhas
sincronizar_repositorio "/root/Projeto-IA/trilha" "Projeto-IA/Trilha"

# 2. Sincroniza o diretório Ro-dou
sincronizar_repositorio "/root/Ro-dou" "Ro-dou"