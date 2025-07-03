document.addEventListener('DOMContentLoaded', () => {
  (async () => {
    // DOM елементи
    const makeSelect = document.getElementById('makeSelect');
    const modelSelect = document.getElementById('modelSelect');
    const yearSelect = document.getElementById('yearSelect');
    const partInput = document.getElementById('partQuery');
    const regionSelect = document.getElementById('regionSelect');
    const searchBtn = document.getElementById('searchBtn');
    const resultsDiv = document.getElementById('results');
    const paginationDiv = document.getElementById('pagination');

    // Състояние на приложението
    let vehiclesData = {};
    let currentOffset = 0;
    let currentQuery = '';
    let currentRegion = 'europe';
    let totalPages = 0;
    const itemsPerPage = 20;

    // Зареждане на данни за автомобили
    async function loadVehicleData() {
      try {
        const res = await fetch('/vehicles.json');
        vehiclesData = await res.json();

        // Нулиране на падащите менюта
        makeSelect.innerHTML = '<option value="">Марка</option>';
        modelSelect.innerHTML = '<option value="">Модел</option>';
        yearSelect.innerHTML = '<option value="">Година</option>';

        // Зареждане на марките
        const makes = Object.keys(vehiclesData.марки);
        makes.forEach(make => {
          const option = document.createElement('option');
          option.value = make;
          option.textContent = make;
          makeSelect.appendChild(option);
        });

        // Зареждане на годините (1970-2025)
        for (let y = 2025; y >= 1970; y--) {
          const option = document.createElement('option');
          option.value = y;
          option.textContent = y;
          yearSelect.appendChild(option);
        }
      } catch (err) {
        console.error('❌ Грешка при зареждане на vehicles.json:', err);
      }
    }

    // Обновяване на моделите при избор на марка
    function updateModels() {
      const selectedMake = makeSelect.value;
      modelSelect.innerHTML = '<option value="">Модел</option>';
      yearSelect.innerHTML = '<option value="">Година</option>';

      if (selectedMake && vehiclesData.марки[selectedMake]) {
        vehiclesData.марки[selectedMake].forEach(model => {
          const option = document.createElement('option');
          option.value = model;
          option.textContent = model;
          modelSelect.appendChild(option);
        });
      }
    }

    // Обновяване на годините при избор на модел
    function updateYears() {
      yearSelect.innerHTML = '<option value="">Година</option>';
      const selectedMake = makeSelect.value;
      const selectedModel = modelSelect.value;
      
      if (selectedMake && selectedModel) {
        for (let y = 2025; y >= 1970; y--) {
          const option = document.createElement('option');
          option.value = y;
          option.textContent = y;
          yearSelect.appendChild(option);
        }
      }
    }

    // Възстановяване на последното търсене
    function restoreLastSearch() {
      const urlParams = new URLSearchParams(window.location.search);
      const savedQuery = urlParams.get('query');
      const savedRegion = urlParams.get('region');

      if (savedQuery) {
        const parts = savedQuery.split(' ');
        if (parts.length >= 4) {
          makeSelect.value = parts[0];
          updateModels();
          modelSelect.value = parts[1];
          updateYears();
          yearSelect.value = parts[2];
          partInput.value = parts.slice(3).join(' ');
        } else {
          partInput.value = savedQuery;
        }
        
        currentRegion = savedRegion || 'europe';
        regionSelect.value = currentRegion;
        currentQuery = savedQuery;
        fetchResults();
        return;
      }
      showRandomResults();
    }

    // Показване на случайни резултати
    function showRandomResults() {
      const sampleWords = ['right fender', 'front bumper', 'side mirror', 'engine mount', 'tail light', 'brake disc'];
      if (!partInput.value.trim()) {
        currentQuery = sampleWords[Math.floor(Math.random() * sampleWords.length)];
        currentRegion = 'global';
        currentOffset = 0;
        fetchResults();
      }
    }

    // Търсене
    async function fetchResults() {
      resultsDiv.innerHTML = 'Търсене...';
      paginationDiv.innerHTML = '';

      try {
        const condition = document.getElementById('conditionSelect').value;
        let response = await fetch(`/search?part=${encodeURIComponent(currentQuery)}&offset=${currentOffset}&region=${currentRegion}&condition=${condition}`);
        let data = await response.json();

        if (!data.results || data.results.length === 0) {
          resultsDiv.innerHTML = 'Няма намерени резултати. Разшири търсенето като избереш Нови, Употребявани, в Европа или Глобално';
          // Скролване до съобщението за липса на резултати на мобилни устройства
          if (window.innerWidth <= 768) {
            setTimeout(() => {
              resultsDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
          }
          return;
        }

        displayResults(data.results);
        
        const totalItems = data.total || data.results.length * 1000;
        renderPagination(totalItems);
        updateUrlWithSearchParams();

        // Скролване до първия резултат на мобилни устройства
        if (window.innerWidth <= 768) {
          setTimeout(() => {
            const firstResult = document.querySelector('.item-link');
            if (firstResult) {
              firstResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }, 100);
        }
      } catch (err) {
        console.error('⚠️ Грешка при търсене:', err);
        resultsDiv.innerHTML = 'Грешка при търсене!';
        // Скролване до съобщението за грешка на мобилни устройства
        if (window.innerWidth <= 768) {
          setTimeout(() => {
            resultsDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 100);
        }
      }
    }

// Функция за зареждане на категориите
    async function loadCategories() {
      try {
        const res = await fetch('parts_categories.json');
        const categories = await res.json();
        const categoryColumn = document.getElementById('categoryColumn');
        
        categories.forEach(category => {
          const details = document.createElement('details');
          details.className = 'category';
          
          const bgCategoryName = category.bg.split(' - ')[0];
          const summary = document.createElement('summary');
          summary.className = 'category-title'; // 👉 добавяме нужния клас
          summary.textContent = bgCategoryName;
          details.appendChild(summary);

          
          const div = document.createElement('div');
          category.children.forEach(subCategory => {
            const button = document.createElement('button');
            button.textContent = subCategory.bg.replace(/^- /, '');
            button.onclick = () => {
              partInput.value = subCategory.en;
              searchBtn.click();
            };
            div.appendChild(button);
          });
          
          details.appendChild(div);
          categoryColumn.appendChild(details);
        });

        // Добавяне на слушател за затваряне на другите категории
        const allDetails = document.querySelectorAll('#categoryColumn details');
        allDetails.forEach(detail => {
          detail.addEventListener('toggle', function() {
            if (this.open) {
              // Затваряне на всички други details елементи
              allDetails.forEach(otherDetail => {
                if (otherDetail !== this) {
                  otherDetail.open = false;
                }
              });
            }
          });
        });
      } catch (err) {
        console.error('Грешка при зареждане на категориите:', err);
      }
    }

    // Обновяване на URL с параметрите на търсенето
    function updateUrlWithSearchParams() {
      const newUrl = `${window.location.pathname}?query=${encodeURIComponent(currentQuery)}&region=${currentRegion}`;
      window.history.replaceState({ path: newUrl }, '', newUrl);
    }

    // Показване на резултати
    function displayResults(items) {
      resultsDiv.innerHTML = '';
      items.forEach(item => {
        const link = document.createElement('a');
        link.className = 'item-link';
        console.log('➡️ Предавано заглавие към product.html:', item.title);
        link.href = `product.html?id=${encodeURIComponent(item.itemId)}&title=${encodeURIComponent(item.title)}&priceBGN=${encodeURIComponent(item.priceBGN)}&query=${encodeURIComponent(currentQuery)}&region=${currentRegion}`;
    
        const div = document.createElement('div');
        div.className = 'item';
        div.innerHTML = `
          <img src="${item.image}" alt="${item.title}">
          <h3>${item.title}</h3>
          <p>Цена: ${item.priceBGN} лв. (${item.priceEUR} €)</p>
        `;

        link.appendChild(div);
        resultsDiv.appendChild(link);
      });
    }

    // Рендиране на пагинация
    function renderPagination(totalItems) {
      totalPages = Math.ceil(totalItems / itemsPerPage);
      const currentPage = Math.floor(currentOffset / itemsPerPage) + 1;
      
      if (totalPages <= 1) {
        paginationDiv.innerHTML = '';
        return;
      }

      paginationDiv.innerHTML = '';

      // Бутони за навигация
      const firstBtn = createPaginationButton('Първа', currentPage === 1, () => {
        currentOffset = 0;
        fetchResults();
      });

      const prevBtn = createPaginationButton('Предишна', currentPage === 1, () => {
        currentOffset = (currentPage - 2) * itemsPerPage;
        fetchResults();
      });

      paginationDiv.appendChild(firstBtn);
      paginationDiv.appendChild(prevBtn);

      // Номера на страници
      const startPage = Math.max(1, currentPage - 2);
      const endPage = Math.min(totalPages, startPage + 4);

      paginationDiv.classList.add('pagination');
    
      for (let i = startPage; i <= endPage; i++) {
        const pageBtn = createPaginationButton(i, false, () => {
          currentOffset = (i - 1) * itemsPerPage;
          fetchResults();
        });
        if (i === currentPage) {
          pageBtn.classList.add('active');
        }
        paginationDiv.appendChild(pageBtn);
      }

      // Бутони за следващи страници
      const nextBtn = createPaginationButton('Следваща', currentPage === totalPages, () => {
        currentOffset = currentPage * itemsPerPage;
        fetchResults();
      });

      const lastBtn = createPaginationButton('Последна', currentPage === totalPages, () => {
        currentOffset = (totalPages - 1) * itemsPerPage;
        fetchResults();
      });

      paginationDiv.appendChild(nextBtn);
      paginationDiv.appendChild(lastBtn);

      // Информация за страниците
      const info = document.createElement('span');
      info.style.margin = '0 10px';
      paginationDiv.appendChild(info);
    }

    // Помощна функция за създаване на бутони
    function createPaginationButton(text, disabled, onClick, isActive = false) {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.disabled = disabled;
      btn.onclick = onClick;
      if (isActive) btn.classList.add('active');
      return btn;
    }

    // Инициализация
    await loadVehicleData();
    await loadCategories();
    restoreLastSearch();

    // Слушатели за промяна
    makeSelect.addEventListener('change', updateModels);
    modelSelect.addEventListener('change', updateYears);

    // Слушател за бутона за търсене
    searchBtn.addEventListener('click', async () => {
      const partText = partInput.value.trim();
      currentRegion = regionSelect.value;
      const condition = document.getElementById('conditionSelect').value;

      if (!partText) {
        alert('Моля, въведете име на частта!');
        return;
      }

      const make = makeSelect.value;
      const model = modelSelect.value;
      const year = yearSelect.value;

      if (make && model && year) {
        currentQuery = `${make} ${model} ${year} ${partText}`;
      } else {
        currentQuery = partText;
      }

      currentOffset = 0;
      await fetchResults();
    });
  })();
});



