# Services & Équipements — Mapbox

Protótipo v1 baseado no design aprovado.

## O que já está implementado

- Mapbox usando o style fornecido.
- Token Mapbox centralizado em `config.js`.
- 53 fontes CSV do Google Sheets centralizadas em `config.js`.
- Cada subcategoria possui seu próprio GeoJSON source.
- Cada subcategoria possui seu próprio cluster.
- Portanto, **subcategorias diferentes nunca são agrupadas no mesmo cluster**.
- Cor = categoria principal.
- Ícone = subcategoria.
- Filtros de categoria e subcategoria.
- Contadores.
- Busca.
- Popup.
- Atualização manual dos CSVs com cache-busting.
- Layout responsivo.

## Como executar

Como os CSVs são carregados pelo navegador, é melhor usar um servidor local.

Exemplo com Python:

```bash
python3 -m http.server 8000
```

Depois abrir:

http://localhost:8000

Não abra o `index.html` diretamente com `file://`.

## Arquivos

- `index.html` — estrutura
- `styles.css` — design
- `config.js` — Mapbox + todas as fontes CSV
- `app.js` — lógica do mapa, dados, filtros, clusters e popups

## Próximo passo recomendado

Precisamos validar o **nome real das colunas dos CSVs**, especialmente:

- latitude
- longitude
- nome
- endereço
- telefone
- website

O código já tenta detectar diferentes nomes de coluna, mas podemos ajustar para o schema real das planilhas depois de testar a primeira carga.

## Regra de clustering

Esta é uma decisão arquitetural importante:

Cada subcategoria tem:

1. seu próprio source;
2. seu próprio cluster layer;
3. seu próprio count layer;
4. seu próprio point layer.

Assim:

`Crèche` agrupa somente `Crèche`.

`École` agrupa somente `École`.

`Pharmacie` agrupa somente `Pharmacie`.

Nunca:

`Crèche + École + Pharmacie`.

Isso preserva exatamente o comportamento solicitado.


## Schema atual das planilhas

Todas as abas compartilhadas seguem este formato:

| Coluna | Uso |
|---|---|
| `Title` | Nome do serviço / estabelecimento |
| `Description` | Descrição apresentada no popup |
| `Commune` | Município |
| `Latitude` | Latitude |
| `Longitude` | Longitude |

O parser agora usa esses nomes diretamente.

A coluna `Description` pode conter `<br>` e o mapa converte esses marcadores em quebras de linha no popup, mantendo o restante do HTML escapado por segurança.

Como `Address`, `Phone`, `Email` e `Website` não fazem parte do schema atual, esses campos simplesmente não aparecem quando não existem na planilha.


## Correção v1.2 — carregamento CSV

O carregamento remoto dos CSVs foi alterado de `Papa.parse(download: true)` para:

`fetch()` → timeout de 15 segundos → `Papa.parse(texto)`

Isso evita que uma única requisição Google Sheets pendente mantenha a interface eternamente no estado "Chargement des services…".

Se uma aba falhar, as outras continuam carregando e o console do navegador mostra qual subcategoria falhou.


## v1.3 — diagnóstico de carregamento

A v1.3:
- desativa a telemetria do Mapbox quando suportada pela versão da biblioteca;
- carrega as 53 fontes individualmente;
- aplica timeout de 15 segundos por fonte;
- mostra barra de progresso;
- mostra cada subcategoria com `…`, `✓` ou `×`;
- mostra a quantidade de registros válidos por fonte;
- permite identificar no console exatamente quais fontes falharam;
- mantém as fontes que funcionaram mesmo quando uma ou mais fontes apresentam erro.


## v1.4 — isolamento Mapbox × dados

A v1.4 separa completamente a inicialização do mapa do carregamento das planilhas.

O CSV começa a carregar assim que o Mapbox dispara `load`, antes de qualquer erro de construção de layer poder bloquear a aplicação. O estado do carregamento mostra:

- Mapbox
- fontes carregadas / total
- layers
- quantidade de serviços
- cada subcategoria com sucesso ou erro

Além disso, erros de Mapbox são capturados com `map.on("error")` e não impedem o diagnóstico dos CSVs.


## v1.5 — correção do parser de coordenadas

O problema identificado na v1.4 foi que o parser lia `Latitude` e `Longitude`
diretamente como `row["latitude"]` / `row["longitude"]`.

O Google Sheets pode preservar maiúsculas, BOM e espaços no nome das colunas.
Assim, a linha era recebida, mas as coordenadas eram consideradas ausentes:
`records = 0`, mesmo com o CSV carregado corretamente.

A v1.5 usa o mesmo lookup normalizado das outras colunas para `Latitude` e
`Longitude`, remove BOM/espaços dos headers e suporta ponto ou vírgula decimal.

Também foi adicionado:
- retry automático uma vez para fontes que falharem;
- contador `válidos / linhas CSV` no diagnóstico.


## v1.6 — filtros de subcategorias

Corrigido o filtro hierárquico:

- desmarcar uma subcategoria não desmarca os irmãos;
- a subcategoria é a fonte de verdade da visibilidade do mapa;
- categoria fica marcada quando todas as subcategorias estão ativas;
- categoria fica em estado indeterminado quando apenas algumas estão ativas;
- categoria fica desmarcada quando nenhuma está ativa;
- clicar na categoria continua ativando/desativando todas as subcategorias.


## v1.8 — filtros sem reconstrução do DOM

A v1.8 corrige a arquitetura do filtro.

O problema persistia porque, a cada clique em uma subcategoria, `renderFilters()`
recriava todos os checkboxes imediatamente. Isso tornava o comportamento frágil
e podia fazer a seleção parecer desaparecer.

Agora:
- o DOM dos filtros não é reconstruído ao clicar em uma subcategoria;
- eventos são delegados nos containers;
- uma subcategoria altera somente o próprio estado;
- o checkbox da categoria é atualizado para checked/indeterminate/unchecked;
- a visibilidade do mapa depende exclusivamente de `subcategoryEnabled`;
- os controles "Toutes les catégories" e "Toutes les sous-catégories" atualizam
  os checkboxes existentes sem reconstruir a interface.
