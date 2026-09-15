# Services & Équipements — v1.9

## Clustering par catégorie

Le clustering est maintenant effectué au niveau de chaque catégorie, et non
plus au niveau de chaque sous-catégorie.

Exemple pour Jeunesse :

- Crèche ✓
- École ✓
- Garderie ✗

La source GeoJSON de **Jeunesse** contient alors les services de Crèche + École.
Mapbox les regroupe donc dans les mêmes clusters.

Chaque sous-catégorie conserve néanmoins sa propre layer de points. Cela permet
de garder son identité et son filtrage indépendants.

### Comportement attendu

- sélectionner une catégorie → toutes ses sous-catégories sont sélectionnées ;
- désélectionner une sous-catégorie → seules ses données disparaissent ;
- le cluster de la catégorie continue de compter les autres sous-catégories ;
- sélectionner uniquement une sous-catégorie → elle apparaît et son cluster de
  catégorie est actif ;
- si aucune sous-catégorie d'une catégorie n'est sélectionnée → son cluster
  disparaît ;
- cliquer sur un cluster zoome vers les points qu'il contient.

Les sources Google Sheets restent configurées dans `config.js`.


## Clusters au zoom

Les clusters de catégorie restent actifs jusqu'au zoom 17 (`clusterMaxZoom: 17`).
Ainsi, en zoomant, un cluster ne disparaît pas immédiatement pour devenir une
multitude de points individuels.

Au-delà du zoom 17, Mapbox affiche les points individuels.
