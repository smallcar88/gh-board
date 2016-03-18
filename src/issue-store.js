import _ from 'underscore';
import {EventEmitter} from 'events';
import Client from './github-client';
import BipartiteGraph from './bipartite-graph';
import {getRelatedIssues} from './gfm-dom';
import {getFilters, filterCardsByFilter} from './route-utils';
import {contains, KANBAN_LABEL, UNCATEGORIZED_NAME} from './helpers';
import Card from './card-model';
import Progress from './progress';
import Database from './database';

const RELOAD_TIME_SHORT = 30 * 1000;
const RELOAD_TIME_LONG = 5 * 60 * 1000;

const toIssueKey = (repoOwner, repoName, number) => {
  return `${repoOwner}/${repoName}#${number}`;
};

function getReloadTime() {
  if (document.hidden) {
    return RELOAD_TIME_LONG;
  } else {
    return RELOAD_TIME_SHORT;
  }
}

let GRAPH_CACHE = new BipartiteGraph();
let CARD_CACHE = {};
const cardFactory = (repoOwner, repoName, number, issue, pr=null, prStatuses=null) => {
  const key = toIssueKey(repoOwner, repoName, number);
  let card = CARD_CACHE[key];
  if (card && issue) {
    card.resetPromisesAndState(issue);
    return card;
  } else if (card) {
    return card;
  } else {
    card = new Card(repoOwner, repoName, number, GRAPH_CACHE, issue, pr, prStatuses);
    _buildBipartiteGraph(GRAPH_CACHE, [card]);
    CARD_CACHE[key] = card;
    return card;
  }
};

export function filterCards(cards, labels) {
  let filtered = cards;
  // Curry the fn so it is not declared inside a loop
  const filterFn = (label) => (card) => {
    const containsLabel = contains(card.issue.labels, (cardLabel) => {
      return cardLabel.name === label.name;
    });
    if (containsLabel) {
      return true;
    } else if (UNCATEGORIZED_NAME === label.name) {
      // If the issue does not match any list then add it to the backlog
      for (const l of card.issue.labels) {
        if (KANBAN_LABEL.test(l.name)) {
          return false;
        }
      }
      // no list labels, so include it in the backlog
      return true;
    }
  };
  for (const i in labels) {
    const label = labels[i];
    filtered = _.filter(filtered, filterFn(label));
    if (filtered.length === 0) {
      return [];
    }
  }
  return filtered;
}

function _buildBipartiteGraph(graph, cards) {
  const allPullRequests = {};
  const allIssues = {};

  _.each(cards, (card) => {
    const cardPath = graph.cardToKey(card);
    if (card.issue.pullRequest) {
      // card is a Pull Request
      allPullRequests[cardPath] = card;
    } else {
      // or card is an Issue
      allIssues[cardPath] = card;
    }
  });

  _.each(cards, (card) => {
    const cardPath = GRAPH_CACHE.cardToKey(card);
    const relatedIssues = getRelatedIssues(card.issue.body, card.repoOwner, card.repoName);
    // NEW FEATURE: Show **all** related Issues/PR's (the graph is no longer bipartite)
    // TODO: Refactor to simplify this datastructure
    //if (card.issue.pullRequest) {
      // card is a Pull Request
      _.each(relatedIssues, ({repoOwner, repoName, number, fixes}) => {
        const otherCardPath = GRAPH_CACHE.cardToKey({repoOwner, repoName, issue: {number}});
        const otherCard = allIssues[otherCardPath] || allPullRequests[otherCardPath];
        if (otherCard) {
          GRAPH_CACHE.addEdge(otherCardPath, cardPath, otherCard, card, fixes);
        }
      });
    //}
  });
}

let cacheCardsRepoInfos = null;
let cacheCards = null;
let isPollingEnabled = false;

class IssueStore extends EventEmitter {
  constructor() {
    super();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        clearTimeout(this.polling);
        delete this.polling;
        if (isPollingEnabled) {
          this.fetchIssues(); // start Polling again
        }
      }
    });
  }
  off() { // EventEmitter has `.on` but no matching `.off`
    const slice = [].slice;
    const args = arguments.length >= 1 ? slice.call(arguments, 0) : [];
    return this.removeListener.apply(this, args);
  }
  clearCacheCards() {
    cacheCards = null;
    cacheCardsRepoInfos = null;
    CARD_CACHE = {};
    GRAPH_CACHE = new BipartiteGraph();
  }
  stopPolling() {
    isPollingEnabled = false;
  }
  startPolling() {
    isPollingEnabled = true;
  }
  issueNumberToCard(repoOwner, repoName, number, issue=null, pr=null, prStatuses=null) {
    if (!(repoOwner && repoName && number)) {
      throw new Error('BUG! Forgot to pass arguments in');
    }
    return cardFactory(repoOwner, repoName, number, issue, pr, prStatuses);
  }
  issueToCard(repoOwner, repoName, issue) {
    if (!(repoOwner && repoName && issue)) {
      throw new Error('BUG! Forgot to pass arguments in');
    }
    return cardFactory(repoOwner, repoName, issue.number, issue);
  }
  // Fetch all the issues and then filter based on the URL
  fetchIssues(progress) {
    const {repoInfos} = getFilters().getState();
    if (!progress) {
      // If no progress is passed in then just use a dummy progress
      progress = new Progress();
    }
    return Client.dbPromise().then(() => this._fetchAllIssues(repoInfos, progress).then((cards) => {
      return filterCardsByFilter(cards);
    }));
  }
  _fetchAllIssuesForRepo(repoOwner, repoName, progress) {
    progress.addTicks(1, `Fetching Issues for ${repoOwner}/${repoName}`);
    const issuesState = Client.canCacheLots() ? 'all' : 'open';
    return Client.getOcto().repos(repoOwner, repoName).issues.fetchAll({state: issuesState, per_page: 100})
    .then((vals) => {
      progress.tick(`Fetched Issues for ${repoOwner}/${repoName}`);
      return vals.map((issue) => {
        return this.issueNumberToCard(repoOwner, repoName, issue.number, issue);
      });
    });
  }
  _fetchLastSeenUpdates(repoOwner, repoName, progress, lastSeenEventId) {
    return Client.getOcto().repos(repoOwner, repoName).issues.events.fetch()
    .then((result) => {
      progress.tick(`Fetched Updates for ${repoOwner}/${repoName}`);
      let newLastSeenEventId;
      // could have 0 events
      if (result.items && result.items.length) {
        newLastSeenEventId = result.items[0].id;
      } else {
        // If a repository has 0 events it probably has not changed in a while
        // or never had any commits. Do not keep trying to fetch all the Issues though
        // so set the lastSeenEventId to be something non-zero
        // since falsy means gh-board has not fetched all the Issuese before.
        newLastSeenEventId = -1;
      }
      let hitLastSeenEventId = false;
      let cards = result.items.map((event) => {
        // Ignore what type of event it was
        const {issue, id} = event;
        if (id && id === lastSeenEventId) {
          hitLastSeenEventId = true;
        }
        if (hitLastSeenEventId) {
          return null;
        }
        console.log('Saw a new event!', repoName, event.event, event.createdAt);
        return this.issueNumberToCard(repoOwner, repoName, issue.number, issue);
      });
      // .reverse because events are newest first but IndexedDB needs them to be newest-last
      cards = cards.reverse();
      // remove the null cards (null because they are not new events)
      cards = _.filter(cards, (card) => { return !!card; });
      const ret = { cards };
      // only include the repository key if the lastSeenEventId changed
      // That way fewer things will need to be saved to the DB
      if (lastSeenEventId !== newLastSeenEventId) {
        ret.repository = {repoOwner, repoName, lastSeenEventId: newLastSeenEventId};
      }
      return ret;
    });
  }
  _fetchUpdatesForRepo(repoOwner, repoName, progress) {
    progress.addTicks(1, `Fetching Updates for ${repoOwner}/${repoName}`);
    return Database.getRepoOrNull(repoOwner, repoName).then((repo) => {
      if (repo && repo.lastSeenEventId) {
        const {lastSeenEventId} = repo;
        // Just fetch the list of events since we already fetched all the closed Issues
        return this._fetchLastSeenUpdates(repoOwner, repoName, progress, lastSeenEventId);
      } else if (!Client.canCacheLots()) {
        // Just keep fetching the 1st page of Open Issues
        return this._fetchAllIssuesForRepo(repoOwner, repoName, progress).then((cards) => {
          return {
            // repository: {repoOwner, repoName},
            cards
          };
        });
      } else {
        // Fetch all the Closed Issues and then fetch the 1st page of events.
        // Combine them and most importantly, the result of the 2nd call will set the lastSeenEventId in the DB
        return this._fetchAllIssuesForRepo(repoOwner, repoName, progress).then((allCards) => {
          return this._fetchLastSeenUpdates(repoOwner, repoName, progress, null /*lastSeenEventId*/).then(({repository, cards}) => {
            if (repository && !repository.lastSeenEventId) {
              throw new Error('BUG! no new lastSeenEventId found');
            }
            return {
              repository,
              cards: allCards.concat(cards)
            };
          });
        });
      }
    });
  }
  _fetchAllIssues(repoInfos, progress, isForced) {
    // Start/keep polling
    if (!this.polling && isPollingEnabled) {
      this.polling = setTimeout(() => {
        this.polling = null;
        this._fetchAllIssues(repoInfos, progress, true /*isForced*/);
      }, getReloadTime());
    }
    if (!isForced && cacheCards && cacheCardsRepoInfos === JSON.stringify(repoInfos)) {
      return Promise.resolve(cacheCards);
    }
    const explicitlyListedRepos = {};
    repoInfos.forEach(({repoOwner, repoName}) => {
      if (repoName !== '*') {
        explicitlyListedRepos[`${repoOwner}/${repoName}`] = true;
      }
    });

    const allPromises = _.map(repoInfos, ({repoOwner, repoName}) => {
      if (repoName === '*') {
        // Fetch all the repos, and then concat them
        progress.addTicks(1, `Fetching list of all repositories for ${repoOwner}`);
        return Client.getOcto().orgs(repoOwner).repos.fetchAll()
        .then((repos) => {
          progress.tick(`Fetched list of all repositories for ${repoOwner}`);
          return Promise.all(repos.map((repo) => {
            // Exclude repos that are explicitly listed (usually only the primary repo is listed so we know where to pull milestones/labesl from)
            if (explicitlyListedRepos[`${repoOwner}/${repo.name}`]) {
              return null;
            }
            return this._fetchUpdatesForRepo(repoOwner, repo.name, progress);
          }));
        })
        .then((issuesByRepo) => {
          // exclude the null repos (ones that were explicitly listed in the URL)
          return _.flatten(_.filter(issuesByRepo, (v) => { return !!v; }), true/*shallow*/);
        });
      } else {
        return this._fetchUpdatesForRepo(repoOwner, repoName, progress);
      }
    });
    return Promise.all(allPromises).then((repoAndCards) => {
      repoAndCards = _.flatten(repoAndCards, true /*shallow*/); // the asterisks in the URL become an array of repoAndCards so we need to flatten
      const repos = _.filter(repoAndCards.map(({repository}) => { return repository; }), (v) => { return !!v; }); // if the lastSeenEventId did not change then repository field will be missing
      const cards = _.flatten(repoAndCards.map(({cards}) => { return cards; }), true /*shallow*/);

      _buildBipartiteGraph(GRAPH_CACHE, cards);

      cacheCards = cards;
      cacheCardsRepoInfos = JSON.stringify(repoInfos);

      // Save the cards and then emit that they were changed
      return Database.putCardsAndRepos(cards, repos).then(() => {
        if (isForced && cards.length) {
          this.emit('change');
        }
        return cards;
      });

    });
  }
  fetchMilestones(repoOwner, repoName) {
    return Client.dbPromise().then(() => Client.getOcto().repos(repoOwner, repoName).milestones.fetchAll());
  }
  fetchLabels(repoOwner, repoName) {
    return Client.dbPromise().then(() => Client.getOcto().repos(repoOwner, repoName).labels.fetchAll());
  }
  tryToMoveLabel(card, primaryRepoName, label) {
    this.emit('tryToMoveLabel', card, primaryRepoName, label);
  }
  tryToMoveMilestone(card, primaryRepoName, milestone) {
    this.emit('tryToMoveMilestone', card, primaryRepoName, milestone);
  }
  moveLabel(repoOwner, repoName, issue, newLabel) {
    // Find all the labels, remove the kanbanLabel, and add the new label
    // Exclude Kanban labels
    const labels = _.filter(issue.labels, (label) => {
      if (UNCATEGORIZED_NAME === label.name || KANBAN_LABEL.test(label.name)) {
        return false;
      }
      return true;
    });
    const labelNames = _.map(labels);
    // When moving back to uncategorized do not add a new label
    if (UNCATEGORIZED_NAME !== newLabel.name) {
      labelNames.push(newLabel.name);
    }

    return Client.getOcto().repos(repoOwner, repoName).issues(issue.number).update({labels: labelNames})
    .then(() => {

      // invalidate the issues list
      cacheCards = null;
      this.emit('change');
    });
  }
  moveMilestone(repoOwner, repoName, issue, newMilestone) {
    // TODO: Check if the milestone exists. If not, create it

    Client.getOcto().repos(repoOwner, repoName).milestones.fetch()
    .then((milestones) => {
      // Find the milestone with a matching Title
      const matchingMilestone = _.filter(milestones, (milestone) => {
        return milestone.title === newMilestone.title;
      })[0];

      return Client.getOcto().repos(repoOwner, repoName).issues(issue.number).update({milestone: matchingMilestone.number})
      .then(() => {

        // invalidate the issues list
        cacheCards = null;
        this.emit('change');
      });

    });

  }
  createLabel(repoOwner, repoName, opts) {
    return Client.getOcto().repos(repoOwner, repoName).labels.create(opts);
  }
}

export default new IssueStore();
