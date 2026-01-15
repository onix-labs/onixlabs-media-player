import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LayoutHeader } from './layout-header';

describe('LayoutHeader', () => {
  let component: LayoutHeader;
  let fixture: ComponentFixture<LayoutHeader>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LayoutHeader]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LayoutHeader);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
